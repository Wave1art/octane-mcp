# Lessons

One lesson per line, in the shape: what happened → the rule → the reason. Merge and delete toward the ~200-line cap rather than appending indefinitely — this file loads in full every session, and an unbounded one degrades adherence to everything in it.

## Store Boundary

The boundary between this file and the harness's private memory is shareability, not content type. The decidable test: would you put this in a PR review comment for a new teammate? Yes → `.zcore/lessons.md`. No → private memory.

Writing a lesson is an interactive-session act. An unattended agent may read this file but never write it.

## Lessons

- `gh issue edit --body-file` with a file holding only the changed line wiped the rest of the issue body → read the body, apply the change in memory, then write the whole thing back → `--body-file` replaces the body; it does not patch it.
