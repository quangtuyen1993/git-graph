import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface AIProvider {
  id: string;
  name: string;
  available: boolean;
  models: string[];
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
        name: 'Claude (CLI)',
        available: true,
        models: ['sonnet', 'opus', 'haiku'],
      });
    }

    // Check if deepseek API key is configured
    const config = vscode.workspace.getConfiguration('gitGraphPro.aiReview');
    const deepseekKey = config.get<string>('deepseekApiKey');
    if (deepseekKey) {
      providers.push({
        id: 'deepseek',
        name: 'DeepSeek (API)',
        available: true,
        models: ['deepseek-chat', 'deepseek-coder'],
      });
    }

    // Check openai CLI
    if (await this.isCommandAvailable('openai')) {
      providers.push({
        id: 'openai',
        name: 'OpenAI (CLI)',
        available: true,
        models: ['gpt-4o', 'gpt-4o-mini', 'o1'],
      });
    }

    // Always offer deepseek as option (user can add key later)
    if (!providers.find(p => p.id === 'deepseek')) {
      providers.push({
        id: 'deepseek',
        name: 'DeepSeek (API)',
        available: false,
        models: ['deepseek-chat', 'deepseek-coder'],
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
        model = model || 'sonnet';
        content = await this.runClaude(fullInput, model);
        break;
      case 'openai':
        model = model || 'gpt-4o';
        content = await this.runOpenAI(fullInput, model);
        break;
      case 'deepseek':
        model = model || 'deepseek-chat';
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

  private async runClaude(input: string, model: string): Promise<string> {
    const args = ['--print', '--model', model];
    return this.spawnWithStdin('claude', args, input);
  }

  private async runOpenAI(input: string, model: string): Promise<string> {
    const args = ['api', 'chat.completions.create', '-m', model, '-g', 'user', input];
    return this.spawnWithStdin('openai', args, '');
  }

  private async runDeepSeek(input: string, model: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('gitGraphPro.aiReview');
    const apiKey = config.get<string>('deepseekApiKey');
    if (!apiKey) {
      throw new Error('DeepSeek API key not configured. Set gitGraphPro.aiReview.deepseekApiKey in settings.');
    }

    // Use curl to call DeepSeek API
    const body = JSON.stringify({
      model,
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
