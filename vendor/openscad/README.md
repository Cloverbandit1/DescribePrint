# Portable / bundled OpenSCAD

This folder is the **drop-in** location for a portable OpenSCAD binary.

M1 does not ship the binary (it is large and licensed separately). A later
packaged build can copy `openscad.exe` (Windows) or `openscad` (macOS/Linux)
here and DescribePrint will find it automatically.

Until then:

1. Install OpenSCAD from https://openscad.org/ (common Windows paths are auto-detected).
2. Or set `OPENSCAD_PATH` to the executable or its folder.
3. Or place `openscad.exe` / `openscad` in this directory.
