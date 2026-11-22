# Editorial profiles and preference evidence

Profiles are immutable versions. Resolution merges the system default, active
user-wide profile, active book profile, an explicitly selected profile, and
decayed optional preference evidence. The resolved configuration and SHA-256
hash are stored on each run so later profile edits cannot rewrite history.

Profile configuration supports style goals, must-preserve rules, protected
elements and claims, character voice traits, desired tendencies, forbidden
tendencies, and configured cliché names. Book profiles override user defaults
only at their declared fields.

Completed-run actions may record optional choices, rejections, undo operations,
or the hash and distance of a manual rewrite. Evidence is ownership-scoped,
exportable, and soft-deletable. Older evidence decays and a minimum evidence
threshold prevents one choice from changing the profile. Feedback is never
required for a current or future workflow to finish.

API endpoints under `/api/editorial/profiles`, proposal preference routes,
preference export/delete, and `/api/books/:bookId/editorial-profile/*` expose
these operations. Avoid storing sensitive manuscript prose in preference
metadata; manual rewrites are represented by hashes and distance statistics.
