# Making a release

For whoever tags a version. A release is what people install and upgrade to, so the steps are few
and the pipeline refuses the ones that are easy to forget.

1. **Everything is on `main` and its pipeline is green.** The tag is made on that commit.
2. **The version**: the same number in `package.json`, `apps/web/package.json` and
   `apps/worker/package.json`. The pipeline refuses a tag that does not match them.
3. **`CHANGELOG.md`**: rename `## Unreleased` to `## <version>`, check that it says what is in it,
   and that it has an **Upgrade notes** list. Write `- None.` if there is nothing to do; the
   pipeline refuses a tag whose version has no such list, because people read it before upgrading.
   Say there: new or changed settings in `.env`, changes to `compose.yaml` they must take over,
   anything that cannot be undone, anything that takes long. Do not add a required setting
   (`${VAR:?...}`) in a version that is not a major one without saying so there.
4. **`README.md`**: the status line names the version.
5. One pull request for steps 2 to 4, titled `add: release <version>`; merge it.
6. **Tag it** on the merged commit, and push the tag:

   ```sh
   git tag -a v<version> -m "Kernic <version>"
   git push origin v<version>
   ```

   The pipeline then runs every check, builds the app and worker images for x86-64 and ARM64 and
   publishes them to the GitHub container registry (`ghcr.io/<owner>/kernic-app`, `kernic-worker`;
   tags `<version>` and, unless the version has a `-`, `latest`), and makes the GitHub Release
   from the changelog (a version with a `-`, such as `0.2.0-rc1`, becomes a pre-release).
7. **Afterwards**: look at the release page; check that the images can be pulled from a machine
   that is not yours (a new package on the registry is private until it is made public); upgrade
   an installation of the previous version with `deploy/upgrade.sh` and look at the result. The
   pipeline does not do that last one yet (see the backlog).

If the pipeline fails after the tag: fix it in a pull request and make the next patch version.
A published tag is never moved or deleted, because someone may already have pulled what it names.
