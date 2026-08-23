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
      content,
      provider: request.provider,
      model,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run AI review with streaming — sends chunks via onChunk callback.
   */
  public reviewStreaming(request: ReviewRequest, onChunk: (text: string) => void): Promise<ReviewResult> {
    const prompt = request.customPrompt || DEFAULT_PROMPT;
    const fullInput = `${prompt}\n\n---\n\n${request.diff}`;
    const model = request.model || '';

    return new Promise((resolve, reject) => {
      let args: string[];
      let command: string;

      switch (request.provider) {
        case 'claude':
          command = 'claude';
          args = ['--print'];
          if (model && model !== 'default') args.push('--model', model);
          break;
        case 'codex':
          command = 'codex';
          args = ['exec'];
          if (model && model !== 'default') args.push('-c', `model="${model}"`);
          break;
        case 'kiro':
          command = 'kiro-cli';
          args = ['chat', '--no-interactive', '--trust-all-tools', '--wrap=never'];
          break;
        case 'openai':
          command = 'openai';
          const m = (model && model !== 'default') ? model : 'gpt-4o';
          args = ['api', 'chat.completions.create', '-m', m, '-g', 'user', fullInput];
          // OpenAI CLI doesn't use stdin well for streaming, fall back to non-streaming
          this.review(request).then(resolve).catch(reject);
          return;
        case 'deepseek':
          // DeepSeek uses curl, fall back to non-streaming
          this.review(request).then(resolve).catch(reject);
          return;
        default:
          reject(new Error(`Unknown provider: ${request.provider}`));
          return;
      }

      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let fullOutput = '';

      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
        fullOutput += chunk;
        onChunk(chunk);
      });

      proc.stderr.on('data', () => { /* ignore stderr */ });

      proc.stdin.write(fullInput);
      proc.stdin.end();

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('AI review timed out after 120 seconds'));
      }, 120_000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({
            content: fullOutput,
            provider: request.provider,
            model: model || 'default',
            timestamp: new Date().toISOString(),
          });
        } else {
          reject(new Error(`${command} failed (exit ${code})`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to run ${command}: ${err.message}`));
      });
    });
  }

  private async runClaude(input: string, model: string): Promise<string> {
    const args = ['--print'];
    if (model && model !== 'default') args.push('--model', model);
    return this.spawnWithStdin('claude', args, input);
  }

  private async runCodex(input: string, model: string): Promise<string> {
    // codex exec reads prompt from stdin when piped
    const args = ['exec'];
    if (model && model !== 'default') args.push('-c', `model="${model}"`);
    const raw = await this.spawnWithStdin('codex', args, input);
    // Strip ANSI escape codes and codex header lines
    return raw
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^OpenAI Codex.*\n/m, '')
      .replace(/^-+\n/m, '')
      .replace(/^(workdir|model|provider|approval|sandbox|reasoning.*|session id):.*\n/gm, '')
      .replace(/^user\n/m, '')
      .replace(/^codex\n/m, '')
      .replace(/^tokens used\n[\d,]+\n/m, '')
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

  private async isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [command], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  private spawnWithStdin(command: string, args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
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
