// Dump templates: structured skeletons the Capture screen can pre-fill into the writing box.
// Add or reword entries freely; `text` is inserted verbatim (cursor lands on the first blank line).
export const TEMPLATES = [
  { id: "morning", label: "Morning pages", text:
`Morning pages — just write, don't edit.

How I woke up feeling:

What's on my mind right now:

What I'm looking forward to / dreading today:

The one thing that would make today a good day:
` },
  { id: "shutdown", label: "Shutdown", text:
`Shutdown — closing the day.

What I got done:

What's still open (and what it needs next):

What I'm letting go of until tomorrow:

Top 3 for tomorrow:
1.
2.
3.
` },
  { id: "meeting", label: "Meeting", text:
`Meeting:
Who was there:
Date:

What was discussed:

Decisions made:

Action items (who / what / by when):
-
` },
  { id: "worry", label: "Worry", text:
`What I'm worried about:

What's actually in my control here:

What isn't, and can I let it go:

The worst realistic outcome — and how I'd cope:

One small step I can take today:
` },
];

// Fill `ta` with a template. A non-empty box keeps its text: the template goes in front of it.
export function applyTemplate(ta, tpl) {
  const cur = ta.value.trim();
  ta.value = cur ? tpl.text + "\n" + ta.value : tpl.text;
  const first = Math.max(0, ta.value.indexOf("\n\n") + 2);
  ta.focus();
  ta.setSelectionRange(first, first);
  return ta.value;
}
