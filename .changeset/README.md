# Changesets

Use `pnpm changeset` to record user-visible changes. Select the affected feature packages and, when necessary, the suite; specify patch/minor/major changes and provide descriptions.

Use `pnpm version:packages` to apply changes, generate the suite, and update the lockfile. Review the changes, then run `pnpm check && pnpm check:pack`.

Feature packages are versioned independently, while the suite represents a verified combination. The configured default branch is `main`; align it with the repository's actual default branch before first use.

There is no automatic publication or push. Publication requires explicit maintainer approval. Do not publish the initial empty suite or generated empty scaffolds.
