# Glim - An Interactive Wellness Companion PWA

A personal pet project. An animated owl-moth creature lives in your browser tab, delivering context-aware encouragement while tracking water intake, steps, nutrition, and journal entries. Built as a progressive web app with offline support and cross-device sync via Firebase.

The creature responds to pointer interactions (click, drag, shake, long-press) with procedural animations and draws from 700+ hand-written messages organized across 29 context pools. Data persists in localStorage for instant reads and syncs to Firestore in the background, so the app works offline and stays consistent across devices.

## What It Does

Glim combines three things into a single tab:

1. **An interactive creature** - an SVG owl-moth with eye tracking, drag physics, idle wandering, autonomous behaviors (sleep, fly attempts, bug chasing), and time-of-day color shifts
2. **Wellness tracking** - water intake (circular progress ring), steps (tiered milestones), nutrition (four independent nutrients with a personal food library), and journaling (prompted free-write with soft-delete)
3. **A personality layer** - 700+ curated messages delivered by context (time of day, interaction type, tracker events, wellness nudges), with references to neuroscience, absurdist humor, and the user's actual life

## Architecture

```
User Interaction
       |
       v
+------------------+     +-------------------+     +-------------------+
|  React UI Layer  |---->|  Zustand Stores   |---->|   localStorage    |
|  (panels, nav,   |     |  (10 domains,     |     |   (per-domain     |
|   creature SVG)  |<----|   selectors,      |<----|    keys, instant   |
+------------------+     |   computed vals)  |     |    read/write)    |
                         +-------------------+     +-------------------+
                                |                          |
                                v                          v
                         +-------------------+     +-------------------+
                         |  Message Engine   |     |  Firebase Sync    |
                         |  (700+ messages,  |     |  (background,     |
                         |   time-of-day,    |     |   domain-aware    |
                         |   interaction,    |     |   merge strategies)|
                         |   wellness pools) |     +-------------------+
                         +-------------------+             |
                                                           v
                                                  +-------------------+
                                                  |    Firestore      |
                                                  |  (subcollections  |
                                                  |   per domain,     |
                                                  |   per-user auth)  |
                                                  +-------------------+
```

Everything runs client-side. The only server dependency is Firebase for authentication (Google sign-in) and cloud storage. Sync runs automatically on app load, every 60 seconds, and on tab focus. GitHub Actions handles CI/CD: pushes to `main` trigger a build that injects Firebase credentials from repository secrets and deploys to GitHub Pages.

## Getting Started

### Requirements

- Node.js 22+
- A Firebase project with Authentication (Google provider) and Firestore enabled

### Configuration

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/ReitheHeroine/Glim.git
cd Glim/client
npm install
```

2. Copy the environment template and fill in your Firebase credentials:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Firebase project values:

```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
```

3. Deploy the Firestore security rules in `firestore.rules` to your Firebase project. These restrict all reads and writes to the authenticated user's own document tree.

### Usage

```bash
# Development server with hot reload
cd client
npm run dev
# Opens at http://localhost:5173/Glim/

# Production build
npm run build
# Output in client/dist/
```

### Deployment

The included GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys automatically on push to `main`. It expects the six `VITE_FIREBASE_*` values as repository secrets.

## Project Structure

```
glim/
├── .github/workflows/
│   └── deploy.yml                  # CI/CD: build + deploy to GitHub Pages
├── client/
│   ├── public/                     # PWA icons, favicon, service worker assets
│   ├── src/
│   │   ├── components/
│   │   │   ├── AmbientBugs.jsx     # Animated background fireflies
│   │   │   ├── Background.jsx      # Time-of-day gradient sky + ground SVG
│   │   │   ├── CompanionPanel.jsx  # Slide-up panel shell (drag-to-dismiss)
│   │   │   ├── JournalPanel.jsx    # Write/review journal entries
│   │   │   ├── MoreMenu.jsx        # Feature grid overlay
│   │   │   ├── NavBar.jsx          # Bottom navigation (6 desktop / 5 mobile)
│   │   │   ├── NutritionPanel.jsx  # Four-nutrient tracker with food library
│   │   │   ├── OwlMoth.jsx         # Creature SVG rendering (pure component)
│   │   │   ├── PersistentReminder.jsx  # Move/eye-break reminder bar
│   │   │   ├── SettingsView.jsx    # Full-screen settings with accordions
│   │   │   ├── SpeechBubble.jsx    # Message display with auto-dismiss
│   │   │   ├── StepsPanel.jsx      # Step counter with tier milestones
│   │   │   ├── WaterPanel.jsx      # Circular progress ring water tracker
│   │   │   └── settings/           # Per-domain settings sub-panels
│   │   ├── stores/
│   │   │   ├── useCreatureStore.js      # Ephemeral visual state (not persisted)
│   │   │   ├── useJournalStore.js       # Journal entries with soft-delete
│   │   │   ├── useMessageStore.js       # Active message and display state
│   │   │   ├── useNutritionStore.js     # Nutrition logs, goals, streaks
│   │   │   ├── useNutritionLibraryStore.js  # Personal food library CRUD
│   │   │   ├── usePokesStore.js         # Interaction counter
│   │   │   ├── useSettingsStore.js       # Reminder intervals
│   │   │   ├── useStepsStore.js         # Step entries with replace semantics
│   │   │   ├── useUIStore.js            # Panel visibility routing
│   │   │   └── useWaterStore.js         # Water entries with bottle config
│   │   ├── utils/
│   │   │   └── dateUtils.js        # Logical day boundary (3 AM rollover)
│   │   ├── App.jsx                 # Auth gate, UID validation, sync lifecycle
│   │   ├── DesktopPet.jsx          # Root component: timers, interactions, creature
│   │   ├── SignIn.jsx              # Google sign-in with PWA fallback
│   │   ├── SplashScreen.jsx        # Loading/greeting screen
│   │   ├── firebase.js             # Firebase init (env-driven config)
│   │   ├── messages.js             # 700+ curated message pools
│   │   ├── storage.js              # localStorage abstraction
│   │   ├── sync.js                 # Bidirectional Firestore sync service
│   │   ├── index.css               # Responsive type scale (14 CSS variables)
│   │   └── glim-animations.css     # All keyframe animations
│   ├── .env.example                # Firebase config template (no secrets)
│   ├── index.html                  # PWA manifest metadata, iOS meta tags
│   ├── package.json                # React 19, Zustand 5, Firebase, Vite 8
│   └── vite.config.js              # React + Tailwind + PWA plugin config
├── firestore.rules                 # Per-user read/write security rules
├── archive/                        # Pre-Vite single-file prototypes (reference only)
│   ├── glim.html                   # Original single-file React build
│   ├── tater.html                  # Sibling prototype, separate app
│   ├── glim-messages.txt           # Message dump from the prototype
│   └── glim-homescreen-mockup.html # Early homescreen mockup
├── docs/                           # RMarkdown design docs and session logs (not tracked)
│   ├── figures/                    # Architecture diagrams (SVG/PNG)
│   └── *.Rmd                       # Master doc, history, handoff, environment
├── icons/                          # Source icon art (exports live in client/public/)
├── .claude/                        # (not tracked)
└── .env.local                      # (not tracked)
```

## Key Design Decisions

**localStorage-first with background cloud sync.** The app never blocks on Firebase. All reads and writes hit localStorage instantly; Firestore sync runs asynchronously on a 60-second interval and on tab focus. This makes the app feel native-fast and fully functional offline. The trade-off is that two devices editing simultaneously can diverge for up to 60 seconds, but for a single-user wellness app, this is an acceptable window. The sync service uses domain-aware merge strategies: additive merge for event logs (water, nutrition), last-write-wins for config/settings, take-the-max for monotonic counters (pokes), and soft-delete propagation for journal entries.

**Soft-delete for cross-device consistency.** Deleting a journal or nutrition entry sets a `deletedAt` timestamp rather than removing the record. Hard-deleting would cause the sync service to re-introduce the entry from the other device's copy on the next pull. Soft-delete propagates the deletion intent across devices without data loss and enables free undo within the 4-second toast window. Water entries are the one exception: they use hard-delete for undo because the sync interval (60s) is much longer than the undo window (4s), making re-introduction unlikely.

**Replace-style step logging instead of additive.** Unlike water (where each entry adds a bottle), steps uses "latest entry per date wins." Users re-enter their total step count from a pedometer or wearable throughout the day. Summing would double-count; replacing with the latest value reflects the actual reading. The store filters entries by logical date, takes the most recent, and derives daily/weekly stats from that single source value.

**3 AM day boundary instead of midnight.** All date logic subtracts 3 hours before extracting the calendar date. An entry logged at 1 AM on April 5 counts as April 4. This accommodates late-night usage patterns without penalizing someone who logs water at 12:30 AM. The boundary is centralized in a single `dateUtils.js` module that all stores import, so adjusting it is a one-line change.

**Curated message pools instead of LLM generation.** The 700+ messages are hand-written and organized into 29 context pools (time-of-day, interaction type, wellness domain, mood). This keeps the author's voice consistent, avoids API latency and costs, and allows precise control over tone. An LLM could not reliably maintain this level of personality without fine-tuning or heavy prompt engineering, and the app works offline without any API dependency.

## Tools and Libraries

React 19, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), Zustand 5 (state management), Firebase Authentication (Google sign-in), Firebase Firestore (cloud sync), `vite-plugin-pwa` (service worker, offline support), ESLint with `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`

## Author

Reina Hastings - [GitHub](https://github.com/ReitheHeroine)
