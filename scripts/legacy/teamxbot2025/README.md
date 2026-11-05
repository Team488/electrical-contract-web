# TeamXbot2025 one-off export

TeamXbot2025 predates the exporter and the snapshot workflow, so its robots were
imported once by hand (2026-11-04, from TeamXbot2025 `main` at `05ea658`). They show on
the site under **Repository → TeamXbot2025** and don't update on their own. Details and
caveats: `TeamXbot2026/plan_Ele_contract.md` §13.7.

Nothing here was committed to TeamXbot2025. To rerun the export:

```bash
# A throwaway checkout next to this repo (SeriouslyCommonLib is a submodule)
git clone --recurse-submodules https://github.com/Team488/TeamXbot2025 ../TeamXbot2025-export
cd ../TeamXbot2025-export
git checkout 05ea658            # or main, if it has moved

# Add the exporter, an `export2025` Gradle task, and PathplannerLib 2025.2.7
# (2025.1.1 can no longer be downloaded)
mkdir -p src/main/java/electrical/report
cp ../electrical-contract-web/scripts/legacy/teamxbot2025/Export2025.java src/main/java/electrical/report/
git apply ../electrical-contract-web/scripts/legacy/teamxbot2025/teamxbot2025.patch

# Build with the 2025 WPILib JDK and write out/<ContractToUse>.json + index.json
JAVA_HOME=/c/Users/Public/wpilib/2025/jdk ./gradlew export2025 --args="out"

# Import each robot. SNAPSHOT_KEY is in SSM at /electrical-contract/SNAPSHOT_KEY
for c in Competition 2024 2023 Robox; do
  node ../electrical-contract-web/scripts/import-snapshot.mjs out/$c.json <api> --repo Team488/TeamXbot2025
done
```

A rerun updates the code fields (CAN IDs, channels, types) and keeps any wiring
entered on the web. Delete the checkout afterwards.

| File | What it is |
|---|---|
| `Export2025.java` | Reads `Contract2025`, `Contract2024`, `Contract2023` and `RoboxContract` by reflection. Readiness comes from each getter's `isXReady()`; the 2025 library has no PDH or power-source data |
| `teamxbot2025.patch` | Adds the `export2025` Gradle task and bumps PathplannerLib |

Other old repos (XBot2024, TeamXbot2023) could be imported the same way, with the
exporter adapted to their contract classes and library version.
