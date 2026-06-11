# Discard legacy sessions without projects

Existing sessions that predate project ownership are treated as dirty legacy data and are not migrated into synthetic projects. The project model requires every session to belong to an explicit project, so legacy sessions without a project ID are discarded during the transition instead of creating inferred projects from runner and directory pairs.
