"""Every test gets its own empty data dir so nothing touches the real
%LOCALAPPDATA%\BrainDumpLite. Must run before `app.db` is imported."""
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="bdl-test-")
os.environ["BRAINDUMP_LITE_DATA"] = _TMP
os.environ.pop("BRAINDUMP_LITE_UPDATE_URL", None)
