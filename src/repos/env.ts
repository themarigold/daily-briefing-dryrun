// The live git check ignores inherited repository, config, transport and prompt overrides.
export function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "SSH_ASKPASS"));
}

/** The live check's git environment for the Tier-B functions it shares with the morning (`src/git.ts`'s
 *  `{ lead }` path): `cleanGitEnv` with git's messages in the C locale, as `hgit` runs every other live call,
 *  so nothing it reads depends on the user's language. The morning's calls never use it. */
export function liveGitEnv(): NodeJS.ProcessEnv {
  return { ...cleanGitEnv(), LC_ALL: "C", LANGUAGE: "C" };
}
