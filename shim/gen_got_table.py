#!/usr/bin/env python3
# Write qtest_table.h: the JUMP_SLOT (GOT) address of every hooked symbol in
# its intended caller, taken from the stock binaries' relocations.
import re, subprocess, sys
sys.path.insert(0, '.')
from check_syms import HOOKS  # noqa: E402  (check_syms runs nothing on import)
