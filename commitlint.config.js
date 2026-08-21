// Conventional commits, because the release notes and the version bump are both derived from
// them. A message that does not parse means a release that silently misses a change.
module.exports = {
    extends: ["@commitlint/config-conventional"],
    rules: {
        // the default 100 is tight for a subject that has to say what changed and why
        "header-max-length": [2, "always", 120],
        // the body carries the reasoning, and it is worth room to breathe
        "body-max-line-length": [2, "always", 100]
    }
};
