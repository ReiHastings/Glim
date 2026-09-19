// -----------------------------------------------------------------------------
// Title:       JournalPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-27
// Purpose:     Renders the journal button and journal panel (write + past
//              views). Reads state from stores directly. Save is delegated
//              to onSave prop because saving coordinates timers across stores
//              (triggerHappy, showMessage) that are managed in DesktopPet.
// Inputs:      onSave(text: string) prop - called when user saves an entry.
//              Reads from useCreatureStore (hue, sat), useUIStore (journal
//              view/text/prompt state), useJournalStore (entries, loading).
// Outputs:     Journal icon button (top-right) + conditionally rendered panel
// -----------------------------------------------------------------------------

import { useCreatureStore } from '../stores/useCreatureStore';
import { useUIStore } from '../stores/useUIStore';
import { useJournalStore } from '../stores/useJournalStore';
import { JOURNAL_PROMPTS } from '../messages';
import { pickRandom } from '../utils';

export default function JournalPanel({ onSave }) {
  const { hue, sat } = useCreatureStore();
  const { showJournal, journalView, journalText, journalPrompt,
    setShowJournal, setShowSettings, setJournalView, setJournalText, setJournalPrompt,
  } = useUIStore();
  const { entries: journalEntries, loading: journalLoading,
    deleteEntry: deleteJournalEntry,
  } = useJournalStore();

  return (
    <>
      {/* ===== JOURNAL BUTTON ===== */}
      <button onClick={() => { setShowJournal(!showJournal); setShowSettings(false); }}
        className="absolute cursor-pointer glim-tap" style={{
          top: "calc(env(safe-area-inset-top, 0px) + 16px)", right: 56, zIndex: 50, width: 32, height: 32,
          background: showJournal ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
          color: showJournal ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)",
          fontSize: 'var(--glim-text-md)', transition: "all 0.2s ease",
        }}
        onPointerEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.15)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; }}
        onPointerLeave={(e) => { e.currentTarget.style.background = showJournal ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)"; e.currentTarget.style.color = showJournal ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)"; }}
      >&#9997;</button>

      {/* ===== JOURNAL PANEL ===== */}
      {showJournal && (
        <div className="absolute" style={{
          top: "calc(env(safe-area-inset-top, 0px) + 56px)", right: 16, zIndex: 50, padding: "16px 20px", borderRadius: 16,
          background: "rgba(0,0,0,0.75)", backdropFilter: "blur(15px)",
          border: "1px solid rgba(255,255,255,0.12)",
          fontFamily: "'Courier New', monospace", color: "rgba(255,255,255,0.85)",
          fontSize: 'var(--glim-text-sm)', width: 340, maxHeight: "70vh", display: "flex", flexDirection: "column",
        }}>
          {/* Tab bar */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={() => setJournalView("write")} className="glim-tap" style={{
              position: "relative",
              flex: 1, padding: "6px 0", borderRadius: 8, cursor: "pointer",
              background: journalView === "write" ? `hsla(${hue}, ${sat}%, 50%, 0.3)` : "rgba(255,255,255,0.05)",
              border: `1px solid ${journalView === "write" ? `hsla(${hue}, ${sat}%, 60%, 0.4)` : "rgba(255,255,255,0.1)"}`,
              color: "rgba(255,255,255,0.85)", fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-sm)',
              letterSpacing: "1px",
            }}>write</button>
            <button onClick={() => setJournalView("past")} className="glim-tap" style={{
              position: "relative",
              flex: 1, padding: "6px 0", borderRadius: 8, cursor: "pointer",
              background: journalView === "past" ? `hsla(${hue}, ${sat}%, 50%, 0.3)` : "rgba(255,255,255,0.05)",
              border: `1px solid ${journalView === "past" ? `hsla(${hue}, ${sat}%, 60%, 0.4)` : "rgba(255,255,255,0.1)"}`,
              color: "rgba(255,255,255,0.85)", fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-sm)',
              letterSpacing: "1px",
            }}>
              past{journalEntries.filter(e => !e.deletedAt).length > 0 && ` (${journalEntries.filter(e => !e.deletedAt).length})`}
            </button>
          </div>

          {/* Write view */}
          {journalView === "write" && (
            <div>
              <div style={{
                padding: "10px 12px", borderRadius: 10, marginBottom: 12,
                background: `hsla(${hue}, ${sat}%, 50%, 0.1)`,
                border: `1px solid hsla(${hue}, ${sat}%, 60%, 0.15)`,
                fontSize: 'var(--glim-text-sm)', lineHeight: 1.5, fontStyle: "italic",
                color: `hsla(${hue}, ${sat - 10}%, 80%, 0.8)`,
              }}>
                {journalPrompt}
              </div>
              <button onClick={() => setJournalPrompt(pickRandom(JOURNAL_PROMPTS))}
                className="glim-tap"
                style={{
                  position: "relative",
                  background: "none", border: "none", cursor: "pointer",
                  color: "rgba(255,255,255,0.35)", fontSize: 'var(--glim-text-xs)', marginBottom: 10,
                  fontFamily: "'Courier New', monospace", padding: 0,
                  transition: "color 0.2s ease",
                }}
                onPointerEnter={(e) => { e.target.style.color = "rgba(255,255,255,0.7)"; }}
                onPointerLeave={(e) => { e.target.style.color = "rgba(255,255,255,0.35)"; }}
              >&#8635; different prompt</button>
              <textarea
                value={journalText}
                onChange={(e) => setJournalText(e.target.value)}
                placeholder="write here..."
                style={{
                  width: "100%", minHeight: 100, maxHeight: 200, padding: "10px 12px",
                  borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.9)",
                  fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-lg)',
                  lineHeight: 1.5, resize: "vertical", outline: "none",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => { e.target.style.borderColor = `hsla(${hue}, ${sat}%, 60%, 0.4)`; }}
                onBlur={(e) => { e.target.style.borderColor = "rgba(255,255,255,0.12)"; }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                <span style={{ opacity: 0.3, fontSize: 'var(--glim-text-xs)' }}>
                  {journalText.length > 0 && `${journalText.length} chars`}
                </span>
                <button
                  onClick={() => { if (journalText.trim()) onSave(journalText); }}
                  disabled={!journalText.trim()}
                  className="glim-tap"
                  style={{
                    position: "relative",
                    padding: "6px 16px", borderRadius: 10, cursor: journalText.trim() ? "pointer" : "default",
                    background: journalText.trim() ? `hsla(${hue}, ${sat}%, 50%, 0.3)` : "rgba(255,255,255,0.05)",
                    border: `1px solid ${journalText.trim() ? `hsla(${hue}, ${sat}%, 60%, 0.4)` : "rgba(255,255,255,0.08)"}`,
                    color: journalText.trim() ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.25)",
                    fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-sm)',
                    transition: "all 0.2s ease",
                  }}
                >save</button>
              </div>
            </div>
          )}

          {/* Past entries view */}
          {journalView === "past" && (
            <div style={{ overflowY: "auto", flex: 1, maxHeight: "55vh" }}>
              {journalLoading ? (
                <div style={{ opacity: 0.4, textAlign: "center", padding: 20 }}>loading...</div>
              ) : journalEntries.filter(e => !e.deletedAt).length === 0 ? (
                <div style={{ opacity: 0.4, textAlign: "center", padding: 20, lineHeight: 1.6 }}>
                  no entries yet.<br />go write something!
                </div>
              ) : (
                journalEntries.filter(e => !e.deletedAt).map((entry) => (
                  <div key={entry.id} style={{
                    padding: "12px 14px", borderRadius: 10, marginBottom: 10,
                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ opacity: 0.4, fontSize: 'var(--glim-text-xs)' }}>
                        {new Date(entry.date).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                          hour: "numeric", minute: "2-digit",
                        })}
                      </span>
                      <button onClick={() => deleteJournalEntry(entry.id)} style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: "rgba(255,255,255,0.2)", fontSize: 'var(--glim-text-base)', padding: "0 2px",
                        fontFamily: "'Courier New', monospace", transition: "color 0.2s",
                      }}
                        onPointerEnter={(e) => { e.target.style.color = "rgba(255,100,100,0.6)"; }}
                        onPointerLeave={(e) => { e.target.style.color = "rgba(255,255,255,0.2)"; }}
                      >&#10005;</button>
                    </div>
                    {entry.prompt && (
                      <div style={{
                        fontSize: 'var(--glim-text-xs)', fontStyle: "italic", opacity: 0.4, marginBottom: 6,
                        lineHeight: 1.4,
                      }}>{entry.prompt}</div>
                    )}
                    <div style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {entry.text}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
