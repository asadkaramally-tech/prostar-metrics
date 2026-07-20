/**
 * /today loading state — the approved skeleton treatment (tokens.css .skel)
 * laid out in the page's real geometry (header, hero split, queue column) so
 * the loaded content does not shift.
 */
export default function TodayLoading() {
  return (
    <div className="dashboard-content" role="status" aria-busy="true" aria-label="Loading Today">
      <span className="sr-only">Loading Today</span>
      <div className="top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="skel" style={{ width: 110 }} />
          <div className="skel" style={{ width: 180, height: 22, marginTop: 10 }} />
          <div className="skel" style={{ width: "min(440px, 100%)", marginTop: 10 }} />
        </div>
        <div className="controls">
          <div className="skel" style={{ width: 230, height: 40, marginBottom: 0 }} />
          <div className="skel" style={{ width: 150, height: 40, marginBottom: 0 }} />
        </div>
      </div>
      <div className="hero split">
        <div className="focal" style={{ minHeight: 420, paddingBottom: 24 }}>
          <div className="skel" style={{ width: "55%" }} />
          <div className="skel" style={{ width: "70%", height: 40, marginTop: 14 }} />
          <div className="skel" style={{ width: "85%", marginTop: 14 }} />
        </div>
        <div className="card" style={{ minHeight: 420 }}>
          <div className="bd">
            <div className="skel" style={{ width: "40%" }} />
            <div className="skel" style={{ width: "100%", height: 220, marginTop: 14 }} />
          </div>
        </div>
      </div>
      <div className="g75">
        <div className="card" style={{ minHeight: 320 }}>
          <div className="bd">
            <div className="skel" style={{ width: "45%" }} />
            <div className="skel" style={{ width: "90%", marginTop: 12 }} />
            <div className="skel" style={{ width: "80%" }} />
            <div className="skel" style={{ width: "85%" }} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="card" style={{ minHeight: 150 }}>
            <div className="bd">
              <div className="skel" style={{ width: "50%" }} />
              <div className="skel" style={{ width: "75%" }} />
            </div>
          </div>
          <div className="card" style={{ minHeight: 150 }}>
            <div className="bd">
              <div className="skel" style={{ width: "50%" }} />
              <div className="skel" style={{ width: "75%" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
