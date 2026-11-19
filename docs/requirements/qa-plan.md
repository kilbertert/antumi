# Requirements and solution slice

This is the acceptance and verification home for the SDLC workflow. Audience:
implementers and the operator accepting this behavior. Source: the approved
conversation scope (ZenTao entry, existing Agent/model selection, requirement
owner confirmation with development input). No live company data belongs here.

Scope: source import, immutable structured revisions, manually curated solution
drafts, review records, selected project and configured knowledge-base evidence,
business project iteration assignment, stale-result detection and idempotent task handoff.
Business projects and iterations have stable directory IDs and per-revision
display labels, separate from repository paths. Legacy text fields remain usable.
The prototype is a single self-contained HTML snapshot per solution.
External prototype providers, automatic knowledge retrieval and enterprise
identities are later slices. Recording a confirmer's name is not authenticated authorization.

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
- R10 / prototype: save a synthetic solution and open its prototype request in
  the standard Agent composer. Verify the saved design and evidence arrive
  without sending. Paste a static HTML sample with inline CSS and a disclosure
  control, preview it, reload before saving, save it and submit for review.
  The same snapshot is visible in review and cannot be edited there. Include
  a script, image URL and redirect in the fixture and verify that preview opens
  no network connections to those resources. Simulate a legacy solution write
  and reopen on new Core. Upgrade Core and desktop together to review prototypes.
  Clean up the synthetic data and browser session.
- R11 / knowledge evidence: configure a temporary Markdown knowledge base and add
  a synthetic document; search by words in its content, preview it, select a
  verbatim quote and save it with a project quote. Expect the knowledge-base
  relative path and file revision in the solution, Agent context and handed-off
  task, with both quotes marked untrusted. Change the knowledge document before
  save, review and handoff; expect each stale quote to block the action. Search
  and preview must stay inside the configured knowledge root, including when a
  symlink points outside it. Verify unselected knowledge files and the knowledge
  directory itself are absent from Agent context and project paths. Repeat with
  no configured knowledge base and with an Obsidian-kind folder. Clean up the
  temporary database, repo and knowledge folder.
- R12 / project iteration: in the test database create a business project and two
  iterations. Assign iteration 1.2 to a requirement, save and restart; expect the
  stable IDs and displayed labels to survive. Close 1.2 and activate 1.3; create
  a new requirement revision and assign 1.3. Expect revision 1 to retain 1.2 and
  revision 2 to show 1.3. Try to create or submit a revision using closed 1.2;
  expect a business rejection and no version increment. Simulate an old Core
  rewriting requirement JSON; verify side-table assignments survive unchanged
  labels, while changed legacy labels are not attached to stale IDs. Inject a
  side-table write failure; expect the whole requirement write to roll back.
  Accept a solution, close its iteration and create the next version in the same
  project; expect accepted history and the next iteration both to remain usable.
  In the actual workbench create a project and iteration, save/reload, activate,
  close with confirmation and switch revisions; check dark/light and narrow
  layouts. Confirm repo paths remain distinct from business project IDs.

- R13 / connections: with synthetic source credential status, model provider and
  MCP configuration, expand external connections in the actual requirement
  workspace. Expect configured/enabled status, no secret values, and links to
  the existing source, model provider and MCP settings. Leave an unsaved
  requirement edit, open settings, return and reopen the requirement; expect the
  draft restored. No automatic tool call or Agent message. Check missing source
  plugin, no configured providers, disabled MCP and older Core capabilities.
  Save a fake MCP credential, change its HTTP URL or stdio command/arguments/cwd
  while leaving the credential blank; expect rejection and old configuration
  unchanged after reload. Re-enter the credential and expect success. Rename or
  change Agent sharing without changing the destination; expect credentials
  retained. Inject a settings-file write failure after the new credential write;
  expect the old target/key to remain usable after reload. Existing name-bound
  MCP credentials must still read and migrate on save. No real credentials or
  network calls in these fixtures. Older desktop clients keep the same RPC;
  downgrading Core after editing MCP credentials requires re-entering those
  credentials because older Core cannot read the new private reference.

Store/service tests and integrated RPC tests execute R1-R4 and protocol gates.
Evidence service tests execute R8 and R11 with temporary repositories, knowledge
folders and files.
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
