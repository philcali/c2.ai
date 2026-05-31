/**
 * Launcher — spawns and manages child processes for backend and frontend.
 *
 * Responsible for:
 * - Spawning the backend (node index.js) and frontend (npx vite) as child processes
 * - Detecting readiness of both processes via stdout monitoring
 * - Handling startup failures with descriptive error messages
 * - Graceful shutdown with SIGTERM → timeout → SIGKILL sequence
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { C2Config } from './config-loader.js';
import { TokenManager } from './token-manager.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface LauncherOptions {
  config: C2Config;
  projectRoot: string;
  tokenManager?: TokenManager;
  initialToken?: { token: string; expiresAt: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const BACKEND_READY_PATTERN = /running on port/i;
const FRONTEND_READY_PATTERN = /Local:|ready in/i;

// ---------------------------------------------------------------------------
// Launcher class
// ---------------------------------------------------------------------------

export class Launcher {
  private readonly config: C2Config;
  private readonly projectRoot: string;
  private readonly tokenManager: TokenManager | undefined;
  private readonly initialToken: { token: string; expiresAt: number } | undefined;

  private backendProcess: ChildProcess | null = null;
  private frontendProcess: ChildProcess | null = null;
  private isShuttingDown = false;

  constructor(options: LauncherOptions) {
    this.config = options.config;
    this.projectRoot = options.projectRoot;
    this.tokenManager = options.tokenManager;
    this.initialToken = options.initialToken;
  }

  // -------------------------------------------------------------------------
  // Start (Tasks 4.1, 4.2, 4.3)
  // -------------------------------------------------------------------------

  /**
   * Start both backend and frontend processes.
   * Resolves when both are ready. Rejects on startup failure or timeout.
   */
  async start(): Promise<void> {
    // Spawn backend
    const backendReady = this.spawnBackend();

    // Wait for backend to be ready before spawning frontend
    await backendReady;

    // Spawn frontend
    await this.spawnFrontend();

    // Both ready — print access URLs
    const backendPort = this.config.port;
    const frontendPort = 5173;
    console.log(`\n  Backend:  http://localhost:${backendPort}`);
    console.log(`  Frontend: http://localhost:${frontendPort}\n`);
  }

  // -------------------------------------------------------------------------
  // Shutdown (Task 4.4)
  // -------------------------------------------------------------------------

  /**
   * Gracefully shut down both child processes.
   * Sends SIGTERM, waits up to 5 seconds, then SIGKILL if needed.
   * Clears all tokens via TokenManager.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    const shutdownPromises: Promise<void>[] = [];

    if (this.backendProcess && !this.backendProcess.killed) {
      shutdownPromises.push(this.terminateProcess(this.backendProcess, 'backend'));
    }

    if (this.frontendProcess && !this.frontendProcess.killed) {
      shutdownPromises.push(this.terminateProcess(this.frontendProcess, 'frontend'));
    }

    await Promise.all(shutdownPromises);

    // Clear all tokens on shutdown
    if (this.tokenManager) {
      this.tokenManager.clearAll();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private spawnBackend(): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        C2_CONFIG_JSON: JSON.stringify(this.config),
      };

      // Pass initial token info if TokenManager is available
      if (this.tokenManager && this.initialToken) {
        env.C2_INITIAL_TOKEN = this.initialToken.token;
        env.C2_INITIAL_TOKEN_EXPIRES_AT = String(this.initialToken.expiresAt);
      }

      this.backendProcess = spawn('node', ['index.js'], {
        cwd: this.projectRoot,
        stdio: 'pipe',
        env,
      });

      let stderrOutput = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Backend failed to start: startup timeout exceeded (30s)'));
        }
      }, STARTUP_TIMEOUT_MS);

      this.backendProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(`[backend] ${text}`);

        if (!resolved && BACKEND_READY_PATTERN.test(text)) {
          resolved = true;
          clearTimeout(timeout);
          resolvePromise();
        }
      });

      this.backendProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        process.stderr.write(`[backend:err] ${text}`);
      });

      this.backendProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Backend failed to start: ${err.message}`));
        }
      });

      this.backendProcess.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const reason = stderrOutput.trim() || `exit code ${code}, signal ${signal}`;
          reject(new Error(`Backend failed to start: process exited unexpectedly (${reason})`));
        }
      });
    });
  }

  private spawnFrontend(): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const uiDir = resolve(this.projectRoot, 'ui');

      this.frontendProcess = spawn('npx', ['vite', '--port', '5173'], {
        cwd: uiDir,
        stdio: 'pipe',
        env: process.env,
      });

      let stderrOutput = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Frontend failed — kill backend too
          this.killBackendOnFrontendFailure();
          reject(new Error('Frontend failed to start: startup timeout exceeded (30s)'));
        }
      }, STARTUP_TIMEOUT_MS);

      this.frontendProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(`[frontend] ${text}`);

        if (!resolved && FRONTEND_READY_PATTERN.test(text)) {
          resolved = true;
          clearTimeout(timeout);
          resolvePromise();
        }
      });

      this.frontendProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrOutput += text;
        process.stderr.write(`[frontend:err] ${text}`);
      });

      this.frontendProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.killBackendOnFrontendFailure();
          reject(new Error(`Frontend failed to start: ${err.message}`));
        }
      });

      this.frontendProcess.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const reason = stderrOutput.trim() || `exit code ${code}, signal ${signal}`;
          this.killBackendOnFrontendFailure();
          reject(new Error(`Frontend failed to start: process exited unexpectedly (${reason})`));
        }
      });
    });
  }

  private killBackendOnFrontendFailure(): void {
    if (this.backendProcess && !this.backendProcess.killed) {
      this.backendProcess.kill('SIGTERM');
    }
  }

  private terminateProcess(proc: ChildProcess, name: string): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      let exited = false;

      const onExit = () => {
        if (!exited) {
          exited = true;
          clearTimeout(forceKillTimeout);
          resolvePromise();
        }
      };

      proc.once('exit', onExit);

      // Send SIGTERM
      proc.kill('SIGTERM');

      // Force kill after timeout
      const forceKillTimeout = setTimeout(() => {
        if (!exited) {
          console.warn(`[launcher] ${name} did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s, sending SIGKILL`);
          proc.kill('SIGKILL');
          // Resolve after SIGKILL — process will exit
          exited = true;
          resolvePromise();
        }
      }, SHUTDOWN_TIMEOUT_MS);
    });
  }
}
