// Who may author the review's own marker comments: the summary (`<!-- crysk-report`, its state and
// ci-admission blocks), the per-finding comments, the closing comment and the outcome comment.
//
// WHY a marker's text proves nothing: anyone who can comment on a pull request can type one, and a
// reader that trusts the newest marker by any author lets that comment stand in for the review. Only
// GitHub's author field is trusted. A bot's login (`github-actions[bot]`, or an App's `*[bot]`) cannot
// be taken by a person. The other trusted logins are named by whoever resolves the trust: the platform
// App's login, the repository's `ci_trusted_actors` read from the default branch, and, for a local run
// that posts under a person's own account, that account's login.
//
// A leaf on purpose: every reader of a marker imports this, so it imports nothing that reads one.

import { isBotLogin } from "../triage/adjudication";

export interface MarkerTrust {
  // Logins besides bots whose marker comments are read. Never "everyone": an empty set reads bots only.
  readonly logins: ReadonlySet<string>;
}

// The trust for these logins plus every bot. Undefined and blank entries add nothing, so a login
// that did not resolve can be passed as is.
export function markerTrust(
  logins: Iterable<string | undefined> = [],
): MarkerTrust {
  const set = new Set<string>();
  for (const login of logins) {
    if (login !== undefined && login.trim().length > 0) set.add(login.trim());
  }
  return { logins: set };
}

export function isTrustedMarkerAuthor(
  login: string | undefined,
  trust: MarkerTrust,
): boolean {
  if (login === undefined) return false;
  return isBotLogin(login) || trust.logins.has(login);
}

// The comments a trusted author wrote, in their original order.
export function markerAuthoredComments<T extends { user?: string }>(
  comments: readonly T[],
  trust: MarkerTrust,
): T[] {
  return comments.filter((comment) =>
    isTrustedMarkerAuthor(comment.user, trust),
  );
}
