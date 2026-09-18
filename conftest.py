"""Root conftest: its only job is to exist.

pytest inserts the directory of every conftest.py it collects into sys.path
(the default "prepend" import mode), so this file is what makes `import app`
work when the suite is started as bare `pytest` rather than `python -m pytest`.
Without it CI collected nothing but ModuleNotFoundError.
"""
