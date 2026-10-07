# Pictures in your notes

A note can include images — screenshots, photos, diagrams — and MD Specpad
handles the fiddly parts for you.

## Adding a picture

Three ways, from quickest to most deliberate:

1. **Paste it.** Take a screenshot (or copy an image anywhere), click into
   your note, and press **Ctrl+V**. The image is saved next to your note
   and appears in the text right where your cursor was.
2. **Drag it in.** Drop an image file straight into the editor, or onto a
   markdown file's row in the sidebar to attach it to the end of that file.
3. **The 🖼 toolbar button.** Browse to an image file and insert a link to
   it at the cursor.

In Raw and Split modes you'll see what's really stored — a small piece of
text like:

```
![holiday-photo](C:/notes/images/holiday-photo.png)
```

The reference uses the image's full (absolute) path, so anything you paste
your note into — an AI assistant, another app — can find the picture
without guessing where the note lives.

The picture itself displays in **Split**, **Edit**, and **Review** modes.

## Where pasted images are kept

Pasted and dropped images are saved as ordinary files near your note, so
your notes stay portable. You choose the arrangement in
[Settings](settings.md) under **Pasted / dropped images**:

- **Subfolder next to the file** (the default) — images go into an
  `images` folder beside the note. Tidy and self-contained.
- **Same folder as the file** — images sit right next to the note.
- **Shared folder at workspace root** — one `images` folder for the whole
  workspace.

The folder's name (`images`) is also yours to change in Settings.

A nice touch: if you drag in an image that already lives somewhere in the
same workspace, the note just points at it where it is — no duplicate copy
is made.

## Viewing image files

Click an image file in the sidebar (or drop one on the window) and it opens
in its own tab as a viewer. Image tabs are display-only — MD Specpad never
edits your pictures.
