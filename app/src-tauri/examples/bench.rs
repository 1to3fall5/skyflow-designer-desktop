//! Temporary: release-mode timing for the compositor.
use skyflow_lib::engine::{Engine, LayerKind};

fn build(n: usize) -> Engine {
    let mut e = Engine::new(n);
    let obs = e.add_layer(LayerKind::Obstacle);
    e.active = obs;
    e.stroke(&[(0.25, 0.25), (0.3, 0.25)], 120.0, 0.5, 1.0, false, "mask", 1, 1.0);
    let paint = e.add_layer(LayerKind::Paint);
    e.active = paint;
    e
}

fn med<F: FnMut() -> f32>(warm: usize, iters: usize, mut f: F) -> f32 {
    for _ in 0..warm { f(); }
    let mut v: Vec<f32> = (0..iters).map(|_| f()).collect();
    v.sort_by(f32::total_cmp);
    v[iters / 2]
}

fn main() {
    println!("{:>6} {:>12} {:>12} {:>12} {:>8}", "n", "full ms", "composite", "stroke", "diff");
    for n in [512usize, 1024, 2048, 4096] {
        let mut e = build(n);
        e.composite();
        let full = med(5, 41, || {
            let t = std::time::Instant::now();
            e.full_dirty = true;
            e.composite();
            let d = e.dirty_rect();
            e.clear_dirty();
            let v = t.elapsed().as_secs_f32() * 1000.0;
            std::hint::black_box(d);
            v
        });

        let mut e = build(n);
        e.composite();
        e.clear_dirty();
        let mut sid = 10u64;
        let step = |e: &mut Engine, sid: &mut u64| {
            *sid += 1;
            e.stroke(&[(0.5, 0.5), (0.53, 0.5)], 40.0, 0.8, 1.0, false, "content", *sid, 1.0);
        };
        let c = med(5, 41, || {
            step(&mut e, &mut sid);
            let t = std::time::Instant::now();
            e.composite();
            let v = t.elapsed().as_secs_f32() * 1000.0;
            let d = e.dirty_rect();
            e.clear_dirty();
            std::hint::black_box(d);
            v
        });
        let s = med(5, 41, || {
            let t = std::time::Instant::now();
            step(&mut e, &mut sid);
            let v = t.elapsed().as_secs_f32() * 1000.0;
            e.composite();
            let d = e.dirty_rect();
            e.clear_dirty();
            std::hint::black_box(d);
            v
        });
        let d = med(5, 41, || {
            step(&mut e, &mut sid);
            e.composite();
            let t = std::time::Instant::now();
            let r = e.dirty_rect();
            let v = t.elapsed().as_secs_f32() * 1000.0;
            e.clear_dirty();
            std::hint::black_box(r);
            v
        });
        println!("{:>6} {:>12.2} {:>12.3} {:>12.3} {:>12.3}   total {:.2} ms",
                 n, full, c, s, d, c + s + d);
    }
}
