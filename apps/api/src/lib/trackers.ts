export interface IssueSource {
  title: string;
  status: string;
  description?: string | null;
  url?: string | null;
}

export interface IssueTracker {
  createIssue(
    report: IssueSource,
    cfg: unknown,
  ): Promise<{ externalId: string; url: string }>;
}

export interface GitHubConfig {
  repo: string;
  token: string;
  labels?: string[];
}

export class GitHubIssueTracker implements IssueTracker {
  async createIssue(report: IssueSource, cfg: GitHubConfig) {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: report.title,
        body: `**${report.status}** — ${report.description ?? ""}\n\n_Reported via Bug Capture — ${report.url ?? ""}_`.trim(),
        labels: cfg.labels ?? ["bug"],
      }),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const j = (await res.json()) as { number: number; html_url: string };
    return { externalId: String(j.number), url: j.html_url };
  }
}
