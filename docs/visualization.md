# Visualization Notes (Web IDE)

## View model

The IDE renders cells as cubes in 3D space:

- X axis: horizontal movement
- Y axis: source rows (rendered downward for readability)
- Z axis: layer separation

This keeps authored vertical flow intuitive while exposing true 3D pointer behavior.

## Required visible cues

- Monaco editor for source authoring
- highlighted pointer position
- animated stepping
- recent movement trail
- runtime panel with:
  - current position
  - current direction
  - stack preview
  - output
  - step count

## Why +Y default matters visually

Because authored source is vertical in v0, execution starts moving along +Y, matching top-to-bottom reading. Branches then appear as explicit turns to Z (up/down layers) or X (left/right) without changing source determinism.
