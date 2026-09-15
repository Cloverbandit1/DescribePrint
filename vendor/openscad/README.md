# Portable / bundled OpenSCAD

This folder is the **drop-in** location for a portable OpenSCAD binary.

The binary is **not** committed (size + separate license). The Windows setup
pack fetches the official 64-bit zip at pack/setup time:

```bat
npm run openscad:portable
```

or `scripts/windows/Install-OpenSCAD-Portable.ps1`. That flattens the zip so
`openscad.exe` sits in this directory. `resolveOpenscad` finds it with no env
change.

Until then / on other machines:

1. Install OpenSCAD from https://openscad.org/ (common Windows paths are auto-detected).
2. Or set `OPENSCAD_PATH` to the executable or its folder.
3. Or place `openscad.exe` / `openscad` in this directory.

`Start-DescribePrint.cmd` runs a preflight `resolveOpenscad` check before `npm run dev`. A missing binary is a warning — Start still launches.
