Feature: Turn a ZenTao requirement into an accepted development brief
  Rule: Source material and previous revisions remain available
    Scenario: Import and revise a requirement
      Given a configured ZenTao inbox with an issue containing text, images and attachments
      When I open it as a requirement and save its goal, scope and acceptance criteria
      Then I can read the original source and both requirement revisions after restarting core
      And opening the same issue again returns the same requirement
    Scenario: Keep histories separate when the connected site changes
      Given a saved requirement from one ZenTao site
      When I connect another site and open an issue with the same number
      Then I see a separate requirement
      And refreshing the old requirement refuses to replace its source history
    Scenario: Restore an unfinished draft
      Given I have unsaved requirement fields, solution text or review feedback
      When I reload the window and reopen the requirement
      Then my edits are restored with their original version
      And I cannot overwrite changes accepted by another window
    Scenario: Protect concurrent edits
      Given two windows opened the same requirement revision
      When one window saves a new revision
      Then the other window cannot overwrite it with its older revision

  Rule: Review and development refer to a specific requirement revision
    Scenario: Review selected project evidence
      Given a requirement linked to a code repository
      When I search its project files, open one, choose a verbatim excerpt and save a solution
      Then the solution keeps the excerpt, repository-relative path and file revision
      And the Agent receives only the selected excerpts as untrusted evidence
      And the development task retains the adopted excerpts with their source paths
      And an excerpt that changed after selection blocks saving, review and handoff
    Scenario: Refuse evidence outside the linked projects
      Given a requirement linked to a code repository
      When I submit a file from another directory or an excerpt absent from the source
      Then the evidence is rejected and no unsupported citation is saved
    Scenario: Accept and hand off a solution
      Given a requirement with an owner, goal, scope, acceptance criteria and repository
      When I save a solution, submit it for review and record the owner's acceptance with the development review
      Then I can create one pending Antumi task carrying the accepted solution and source snapshot
      And repeating the handoff returns the same task without starting an Agent
    Scenario: Revise an accepted requirement
      Given an accepted solution for revision 2
      When I save requirement revision 3
      Then the old solution and its review remain visible
      And the old solution is marked as needing review and cannot be handed off against revision 3
    Scenario: Use the existing Agent selection
      Given a saved requirement
      When I choose to analyze it
      Then the existing conversation composer contains its revision and structured fields
      And I choose the Agent, model and provider using Antumi's existing controls

  Rule: Existing clients and workflows keep working
    Scenario: Use core without requirements support
      Given a client connected to core without the requirements capability
      Then no requirements action is shown
      And existing source import, conversations and development tasks remain usable
