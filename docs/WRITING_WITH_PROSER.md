# Writing with Proser

This guide is for writers. It covers the everyday work: starting a book,
writing, getting work back after a problem, bringing in a Word manuscript,
exporting, and turning on the AI helpers. Setting up the server is in the
[installation guide](../README.md#quick-start).

## Start a book

Sign in, then choose **Create New Project** on the Dashboard. Give the book a
title; the genre and summary are optional and can be changed later with
**Edit Project**. The sidebar then works on that book:

- **Story Bible** keeps characters, places and other notes about the world.
- **Plot Studio** tracks plot threads across the book.
- **Manuscript** is where you write.
- **Publish** exports the book and imports Word manuscripts.

On a phone, Proser opens the mobile view. **Quick Draft** there starts a new
scene (or a new book) from a short summary, and you can carry on at a desk later.

## Write and save

Open **Manuscript**, pick a chapter and scene, and type. Proser saves on its own
while you write; the status next to the scene says **Saving…** and then
**Saved**. You do not need a save button.

Every save is kept as a revision, so earlier versions of a scene are not lost.
If someone else (or another tab) changed the same scene, Proser does not
overwrite it: it shows both versions and asks which to keep.

## Get work back after a problem

While you type, Proser also keeps a copy of the scene in your browser. If the
browser closes, the connection drops or the server is restarting before a save
finishes, open the scene again and Proser offers what it kept:

- **Restore retained draft** puts your unsaved text back so it can be saved.
- **Discard retained draft** throws the browser copy away and keeps the saved
  version.
- **Download** buttons save the kept text to a file, which is the safe choice
  when you are not sure.

A copy whose save Proser never confirmed is kept until you restore, download
or discard it. When you sign out and the browser still holds unsaved drafts,
Proser lists them and lets you download them, remove them from this browser
(do this on a shared or borrowed computer), or keep them for next time.

## Get a deleted book back

Deleting a book from the Dashboard moves it to **Deleted books** at the bottom
of the Dashboard. **Restore** brings it back with its scenes, Story Bible and
layout as they were when it was deleted.

## Import a Word manuscript

Go to **Publish**, find **Import a DOCX manuscript** and choose **Choose DOCX
file**. Proser converts the file and shows a preview of what it found: chapters,
scenes, images and anything it could not convert. Nothing changes in your book
until you tick the confirmation and choose **Commit reviewed import**. The
original file is kept with the book, so you can download it again from the
preview.

## Export or publish

**Publish** turns the saved book into a file: Word (DOCX), PDF, EPUB, HTML,
Markdown or plain text. Choose:

- the **format**;
- the **mode**: the final text, the original text, or the text with tracked
  changes and comments kept for review;
- the **preset**: your saved layout, a standard submission manuscript, or a
  print book layout.

Exports always use the last saved revision, so save (or wait for **Saved**)
before exporting. Each export is recorded with the revision it came from, and
you can download it again later.

## Track progress and goals

**Analytics** in the sidebar shows the open book's word count, the words you
wrote each day over the last week, month or three months, your best day and
your writing streak. Words count when they are saved, in your own time zone.
Text that came from an import, the AI or a workflow is shown separately and
never counts toward goals or streaks.

Under **Goals**, set a length for the book, a deadline and a daily goal (any of
them, or none). Proser then tells you how many words are left today and how
many a day would finish the book on time; with a daily goal, a streak day is a
day you reached it. The Dashboard shows the streak and a few suggested next
steps for the open book.

**Plot Studio** shows the story archetype the book follows, with a description
of each one. Choose or change it with **Edit Project** on the Dashboard.

## Set up AI

Proser writes, revises and reviews with a language model that you or your
administrator connect. Without one, everything above still works; the AI
actions report that the model is unavailable.

- **Settings → AI Config** shows which model server Proser uses, and **Test
  Connection** checks that it answers. The server address and model are set by
  whoever runs the installation (`INFERENCE_HOST` and `INFERENCE_MODEL` in
  `.env.compose`), so Settings shows them read-only.
- A model running on the same computer as Docker (for example Ollama or
  llama.cpp) or on your local network works. The
  [Compose guide](COMPOSE.md#optional-providers) has worked examples, including
  a suite gateway that needs a key.
- Images use a separate image server (`WEBUI_FORGE_URL`), also optional.

Your manuscripts are only sent to the model servers your installation is
configured to use.

## Where to go next

- [Compose guide](COMPOSE.md): backups, restores and upgrades for whoever runs
  Proser.
- [Mobile writing](../ProserAuthor/docs/MOBILE.md): the phone and tablet views.
- [Structured editor](../ProserAuthor/docs/STRUCTURED_EDITOR.md): how the
  editor keeps revisions and recovery copies, in technical detail.
