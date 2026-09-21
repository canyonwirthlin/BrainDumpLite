====================================
  BrainDump Lite — how to start
====================================

WHAT IS THIS?
A "second brain" app. You dump whatever's in your head (typing or
talking), and an AI sorts it into tasks, ideas, and worries, then
helps you reflect on it. Everything is stored on YOUR computer only.

HOW TO INSTALL IT
1. Download "BrainDump Lite_x.y.z_x64-setup.exe" from
   https://github.com/canyonwirthlin/BrainDumpLite/releases/latest
2. Run it. Windows may say "Windows protected your PC" because the app
   isn't signed (signing costs money). Click "More info" -> "Run anyway".
   If your antivirus quarantines it, restore it and allow it - it's from me.
3. It installs in a few seconds and opens. There's a Start Menu entry and
   a tray icon (bottom-right, near the clock). Closing the window keeps it
   running in the tray; right-click the tray icon -> Quit to fully exit.
   (Prefer it to just quit? Settings -> Data -> "Quit when I close the window".)
   The app only opens once - launching it again brings the open window forward.

ON A MAC
1. Download the .dmg from the same page: "BrainDump Lite_x.y.z_aarch64.dmg" for
   Apple Silicon (M1/M2/M3/M4), or "..._x64.dmg" for an Intel Mac. (Apple menu ->
   About This Mac shows which chip you have.)
2. Open the .dmg and drag BrainDump Lite into Applications.
3. The first time, macOS says it can't verify the app (I don't pay Apple for
   a developer certificate). Don't double-click it: open Applications, right-click
   (or Control-click) BrainDump Lite -> Open -> Open. If there's no Open button,
   go to System Settings -> Privacy & Security, scroll down, and click
   "Open Anyway" next to BrainDump Lite. You only do this once.
4. It lives in the menu bar at the top right. Closing the window keeps it
   running; click the Dock icon to bring it back, or menu bar icon -> Quit.
Your dumps are stored in ~/Library/Application Support/BrainDumpLite.
The "built-in AI" option is Windows-only for now; on a Mac, pick Gemini
(free) when it asks - the app walks you through getting the key.

UPDATES
The app checks for updates when it starts. When one exists a small
"update available" pill appears at the top - click it, read what's new,
press "Install and restart". That's it.

COMING FROM THE OLD ZIP VERSION?
Just install this one. Your dumps, settings and downloaded AI models are
picked up automatically (same data folder). Delete the old unzipped folder
whenever you like.

TURNING ON THE AI (one-time, ~5 minutes + a download)
The app works without AI but it's 10x better with it. Three options:

OPTION 1: BUILT-IN, FREE (recommended — no account, no other apps)
  1. In the app, click Settings → pick "Built-in".
  2. The app looks at your graphics card and puts a star next to the
     model that fits it best. Click that model's button.
  3. Wait for the download (2-5 GB, one time only). When it says
     "Built-in AI is ready", you're done — forever, even offline.
  Nothing you write ever leaves your computer. Zero cost.
  NOTE: some antivirus apps (Avast/AVG especially) may quarantine the
  AI engine the first time it runs, because it's a new unsigned
  program. If the app tells you this happened: open your antivirus,
  restore/allow "llama-server.exe", add the folder the app shows you
  to the antivirus exclusions, and press the model button again.

OPTION 2: PAID CLOUD (~1-5 cents per day)
  1. In the app, click "Settings".
  2. Pick "Claude" or "OpenAI".
  3. Get an API key:
     - Claude: console.anthropic.com → API Keys → Create Key
     - OpenAI: platform.openai.com → API Keys → Create Key
  4. Add a few dollars of credit to their site (you'll use only cents/day)
  5. Paste the key in Settings, click "Test", then "Save".

OPTION 3: NONE (app works fine, just won't auto-organize your dumps)

VOICE
Click the mic, talk, click it again. The first time takes a minute
(it downloads a small speech model). Your voice is transcribed ON
your computer — audio is never uploaded anywhere.

PRIVACY
- Your dumps are stored only on your computer.
- With Claude/OpenAI selected, the TEXT of your dumps is sent to that
  provider to be processed (same as using their chat apps).
- Voice audio never leaves your machine.

PROBLEMS?
Quit from the tray icon, start it again. If it crashes, it saves the
error to a file and tells you where — send me that file. Still
broken? Tell me (that's the point — I want your feedback!).
