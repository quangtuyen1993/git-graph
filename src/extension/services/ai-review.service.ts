import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface AIProvider {
  id: string;
  name: string;
  available: boolean;
  group: 'cli' | 'api';
}

export interface ReviewRequest {
  diff: string;
  provider: string;
  model?: string;
  customPrompt?: string;
}

export interface ReviewResult {
  content: string;
  provider: string;
  model: string;
  timestamp: string;
}

const DEFAULT_PROMPT = `You are a senior code reviewer. Review this git diff and provide:
1. **Summary** — what this change does in 2-3 sentences
2. **Issues** — bugs, security concerns, performance problems (Critical/Important/Minor)
3. **Suggestions** — improvements, better patterns, missing edge cases
4. **Verdict** — APPROVE, REQUEST_CHANGES, or COMMENT

Be concise and actionable. Focus on real problems, not style nitpicks.`;

export class AIReviewService {
  /**
   * Detect which AI CLI providers are available on the system.
   */
  public async detectProviders(): Promise<AIProvider[]> {
    const providers: AIProvider[] = [];

    // Check claude CLI
    if (await this.isCommandAvailable('claude')) {
      providers.push({
        id: 'claude',
        name: 'Claude',
        available: true,
        group: 'cli',
      });
    }

    // Check codex CLI
    if (await this.isCommandAvailable('codex')) {
      providers.push({
        id: 'codex',
        name: 'Codex',
        available: true,
        group: 'cli',
      });
    }

    // Check kiro CLI
    if (await this.isCommandAvailable('kiro-cli')) {
      providers.push({
        id: 'kiro',
        name: 'Kiro',
        available: true,
        group: 'cli',
      });
    }

    // Check if deepseek API key is configured
    const config = vscode.workspace.getConfiguration('gitGraphPro.aiReview');
    const deepseekKey = config.get<string>('deepseekApiKey');
    providers.push({
      id: 'deepseek',
      name: 'DeepSeek',
      available: !!deepseekKey,
      group: 'api',
    });

    // Check openai CLI (also api-based)
    if (await this.isCommandAvailable('openai')) {
      providers.push({
        id: 'openai',
        name: 'OpenAI',
        available: true,
        group: 'api',
      });
    }

    console.log('[AIReview] Detected providers:', JSON.stringify(providers), 'paths:', JSON.stringify([...this.commandPaths]));
    return providers;
  }

  /**
   * Run AI review on a diff string.
   */
  public async review(request: ReviewRequest): Promise<ReviewResult> {
    const prompt = request.customPrompt || DEFAULT_PROMPT;
    const fullInput = `${prompt}\n\n---\n\n${request.diff}`;

    let content: string;
    let model = request.model || '';

    switch (request.provider) {
      case 'claude':
        content = await this.runClaude(fullInput, model);
        break;
      case 'codex':
        content = await this.runCodex(fullInput, model);
        break;
      case 'kiro':
        content = await this.runKiro(fullInput);
        break;
      case 'openai':
        content = await this.runOpenAI(fullInput, model);
        break;
      case 'deepseek':
        content = await this.runDeepSeek(fullInput, model);
        break;
      default:
        throw new Error(`Unknown AI provider: ${request.provider}`);
    }

    return {
      content: content.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ''),
      provider: request.provider,
      model,
      timestamp: new Date().toISOString(),
    };
  }

  private async runClaude(input: string, model: string): Promise<string> {
    const args = ['--print'];
    if (model && model !== 'default') args.push('--model', model);
    return this.spawnWithStdin('claude', args, input);
  }

  private async runCodex(input: string, model: string): Promise<string> {
    const args = ['exec', '--skip-git-repo-check'];
    if (model && model !== 'default') args.push('-c', `model="${model}"`);
    const raw = await this.spawnWithStdin('codex', args, input);
    // Strip ANSI escape codes
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
    // Extract content between "codex\n" and "tokens used\n"
    const codexIdx = clean.indexOf('\ncodex\n');
    const tokensIdx = clean.indexOf('\ntokens used\n');
    if (codexIdx !== -1 && tokensIdx !== -1) {
      return clean.substring(codexIdx + 7, tokensIdx).trim();
    }
    // Fallback: strip known header patterns
    return clean
      .replace(/^Reading prompt from stdin\.\.\.\n/m, '')
      .replace(/^OpenAI Codex.*\n/m, '')
      .replace(/^-+\n/m, '')
      .replace(/^(workdir|model|provider|approval|sandbox|reasoning.*|session id):.*\n/gm, '')
      .replace(/^-+\n/m, '')
      .replace(/^user\n/m, '')
      .replace(/[\s\S]*?\ncodex\n/m, '')
      .replace(/\ntokens used\n[\d,]+\n[\s\S]*$/m, '')
      .trim();
  }

  private async runKiro(input: string): Promise<string> {
    const args = ['chat', '--no-interactive', '--trust-all-tools', '--wrap=never'];
    const raw = await this.spawnWithStdin('kiro-cli', args, input);
    // Strip ANSI escape codes from output
    return raw.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private async runOpenAI(input: string, model: string): Promise<string> {
    const m = (model && model !== 'default') ? model : 'gpt-4o';
    const args = ['api', 'chat.completions.create', '-m', m, '-g', 'user', input];
    return this.spawnWithStdin('openai', args, '');
  }

  private async runDeepSeek(input: string, model: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('gitGraphPro.aiReview');
    const apiKey = config.get<string>('deepseekApiKey');
    if (!apiKey) {
      throw new Error('DeepSeek API key not configured. Set gitGraphPro.aiReview.deepseekApiKey in settings.');
    }

    const m = (model && model !== 'default') ? model : 'deepseek-chat';

    const body = JSON.stringify({
      model: m,
      messages: [{ role: 'user', content: input }],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const args = [
      '-s', '-X', 'POST',
      'https://api.deepseek.com/chat/completions',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-d', body,
    ];

    const raw = await this.spawnWithStdin('curl', args, '');
    try {
      const response = JSON.parse(raw);
      if (response.error) {
        throw new Error(response.error.message || 'DeepSeek API error');
      }
      return response.choices?.[0]?.message?.content ?? 'No response';
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`DeepSeek API returned invalid JSON: ${raw.substring(0, 200)}`);
      }
      throw e;
    }
  }

  private commandPaths = new Map<string, string>();

  private async isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [command], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: this.getEnv(),
      });
      let path = '';
      proc.stdout?.on('data', (d: Buffer) => { path += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0 && path.trim()) {
          this.commandPaths.set(command, path.trim());
          resolve(true);
        } else {
          resolve(false);
        }
      });
      proc.on('error', () => resolve(false));
    });
  }

  private getEnv(): Record<string, string | undefined> {
    const env = { ...process.env };
    // Ensure common user bin paths are in PATH
    const extraPaths = [
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.nvm/versions/node/v24.2.0/bin`,
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];
    const currentPath = env.PATH || '';
    env.PATH = [...extraPaths, currentPath].join(':');
    return env;
  }

  private spawnWithStdin(command: string, args: string[], stdin: string): Promise<string> {
    // Use resolved full path if available
    const resolvedCommand = this.commandPaths.get(command) || command;
    console.log(`[AIReview] Spawning: ${resolvedCommand} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const proc = spawn(resolvedCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.getEnv(),
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      if (stdin) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`AI review timed out after 120 seconds`));
      }, 120_000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to run ${command}: ${err.message}`));
      });
    });
  }
}
