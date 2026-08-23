# Keyboard Learning App — Planning Set

This directory contains the Milestone 0 planning deliverables for the keyboard-learning
app (working name: **KeyPath**). No application code has been written yet — this is the
requirements, architecture, and roadmap package for review and approval before
implementation begins.

## Contents

1. [Product Requirements Document](./01-product-requirements.md) — vision, personas,
   V1 feature scope, non-functional requirements, explicit out-of-scope list.
2. [Technical Architecture](./02-technical-architecture.md) — shared-codebase strategy,
   monorepo layout, MIDI/audio/notation stack, backend, offline/sync model.
3. [Screen Map](./03-screen-map.md) — full IA, navigation model, and per-screen
   responsibilities, including the Learn My Music and audio-upload flows.
4. [Database Structure](./04-database-schema.md) — entity list, ER diagram, and
   table-by-table field definitions across content, progress, gamification, and
   user-upload domains.
5. [Development Roadmap](./05-roadmap.md) — milestone sequence (M0–M10) with goals,
   deliverables, and exit criteria for each.

## How to review

These five documents are meant to be read in order but are cross-referenced — e.g.
roadmap milestones cite the PRD feature IDs and architecture packages they deliver.
Open questions and decisions that need your sign-off are called out inline with
**`DECISION NEEDED:`**.

Once this set is approved, Milestone 1 (repo scaffolding) is the first place any code
gets written.
