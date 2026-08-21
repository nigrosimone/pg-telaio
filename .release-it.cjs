// Drives `npm run release` and the dispatch path of the Release workflow: it bumps the version
// from the conventional commits, writes CHANGELOG.md, commits, tags and pushes. The npm publish
// and the GitHub release happen in the workflow, not here.
module.exports = {
    git: {
        commitMessage: "chore(release): ${version}",
        tagName: "v${version}",
        tagAnnotation: "Release ${version}"
    },
    npm: {
        publish: false
    },
    github: {
        release: false
    },
    plugins: {
        "@release-it/conventional-changelog": {
            preset: {
                name: "conventionalcommits"
            },
            infile: "CHANGELOG.md"
        }
    }
};
