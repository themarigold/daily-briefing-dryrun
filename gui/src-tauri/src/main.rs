// Prevents a second, console window from opening alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The SPK-1(b) probe gate, and the only branch this binary has — and it is COMPILED OUT unless
    // the `tcc-probe` feature is on, which it is not by default. A shipped build therefore has no
    // branch here at all and no `--tcc-probe` string to find; a spike build has one that returns
    // `None` for every argv that is not `--tcc-probe <dir>` in position 1, so an ordinary launch
    // still reaches `run()` having done nothing but compare one string.
    //
    // `tests/probe_feature_gate.rs` scans the BUILT BINARY for the literal in both feature
    // configurations, so the `cfg` below cannot be dropped silently — and, in a third test that is
    // NOT itself `cfg`'d, pins the manifest so the feature cannot simply be switched on by default
    // (which would compile the objecting test out rather than fail it). Under
    // the feature it also execs that binary with `--tcc-probe <scratch dir>` and requires the
    // documented JSON on stdout — which is what covers THIS wiring: deleting the two lines below
    // used to leave every test green while turning the probe invocation into a window launch.
    // The dispatch logic itself lives in the lib because `tests/tcc_probe.rs` has to reach it.
    #[cfg(feature = "tcc-probe")]
    if let Some(code) = daily_briefing_gui_lib::probe::dispatch(std::env::args_os()) {
        std::process::exit(code);
    }
    daily_briefing_gui_lib::run()
}
