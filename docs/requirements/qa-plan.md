# Requirements and solution slice

This is the acceptance and verification home for the first SDLC slice. Audience:
implementers and the operator accepting this behavior. Source: the approved
conversation scope (ZenTao entry, existing Agent/model selection, requirement
owner confirmation with development input). No live company data belongs here.

Scope: source import, immutable structured revisions, manually curated solution
drafts, review records, stale-result detection and idempotent task handoff.
Business project/version are labels in this slice, separate from repository
paths. Automatic knowledge retrieval, prototypes and enterprise identities are
later slices. Recording a confirmer's name is not authenticated authorization.

## Cases

Environment: Node >=22.13, test homes/databases only. Use a synthetic ZenTao
provider, synthetic issue and temporary repository. Never read real credentials.

- R1 / source history: open one source issue twice; save structured fields; restart
  the store; compare original text/images/attachment references and revisions.
  Expect one requirement, both revisions and unchanged old snapshot. Switch
  source sites with the same issue key: expect separate histories and refusal to
  refresh the old requirement or download its attachments from the new site. Cleanup:
  close database handles and remove the temporary home.
- R2 / conflict: open revision 1 in two clients; save in one; save with the old
  revision in the other. Expect a conflict and preservation of the first change.
- R8 / project evidence: in a temporary git repo, search a synthetic Markdown file,
  preview it, select a quote and save. Expect path, exact excerpt and mtime in the
  saved solution, Agent context and development task. Change the file before
  saving or review and expect a stale-evidence error. Try a sibling path and a
  symlink escaping the repo; both must be rejected. Binary, invalid UTF-8 and
  files over the existing 2 MiB preview limit must return a visible error.
- R9 / architecture proposal: request analysis with a synthetic requirement and
  selected project excerpt. Expect the standard Agent conversation to ask for
  component boundaries, flows, data/API, security, alternatives, migration and
  acceptance tests; evidence facts must name their source path and unverified
  facts stay explicit. Confirm no message is sent until the user chooses to send.
- R3 / review and handoff: save goal/scope/acceptance/owner and repository; save a
  solution; submit; record development feedback and owner acceptance; hand off
  twice. Expect the same pending task, full brief/source and no Agent launch.
  Restart after task creation and retry. A duplicate writer must roll back without
  leaving an orphan task; the task and solution link are committed together.
- R4 / change: accept a solution, save another requirement revision; try handing
  off the old one. Expect stale review rejection; history stays readable.
- R5 / Agent draft: open analysis from the saved revision; inspect the standard
  composer. Expect structured context and source marked as untrusted; the normal
  Agent/model/provider selectors remain available, planning/read-only is the
  default, and source images carry into the composer. Nothing sends automatically.
- R6 / desktop: open inbox action, fill fields, save, edit solution, submit,
  accept, create task and return to inbox. Check keyboard labels, dark/light
  tokens, unsaved-change protection and visible error/retry behavior. Reload the
  window with unsaved form/solution/review text; reopen and expect draft recovery
  with its original version. A newer server version must refuse the restored write.
- R7 / compatibility: run typecheck, all tests and desktop build. Verify task
  imports, stores, protocol and source paths independently; no new RPC is allowed
  on phones or locked channel-tool connections. Test old cores without the feature.

Store/service tests and integrated RPC tests execute R1-R4 and protocol gates.
Evidence service tests execute R8 with temporary repositories and files.
Desktop interaction evidence for R5-R6 must be reported separately from tests;
R9 prompt checks run with the core suite and verify the architecture output sections;
headless Chromium interaction covers the renderer with a test preload bridge,
but does not prove Windows Electron, native dialogs or live integrations. Retain run
identity, environment, timestamp and output in the private task evidence area.

No coverage/mutation tool is configured for this repository. Use focused tests
for concurrency, persisted history, review guards and interrupted handoff rather
than introducing a test framework for this slice.

Source binding uses credential-bound site settings, without storing credentials.
Changing the site creates a separate requirement and cannot refresh old history.

New schemas/RPCs are additive and advertised only when wired. Existing clients
can ignore the new feature. Existing database rows are untouched; rolling back
code leaves the new tables intact, and older core ignores them. No migration
deletes user data. Merge, activation, packaging and deployment are separate.
