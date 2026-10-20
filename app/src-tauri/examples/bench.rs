//! Temporary: release-mode timing for the compositor.
use skyflow_lib::engine::effect::{disturbance_amount, LayerEffect};
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

    // ---- obstacle mask ----------------------------------------------------
    //
    // Two cases, because they are not the same thing any more. An obstacle is
    // a cut-out: it writes the "does not flow" channel and nothing else. The
    // 绕流 effect is what bends the field around it, and it is the only reason
    // an obstacle ever costs more than a paint layer — it has to blur the mask
    // into a plane first.
    //
    // Both used to be one path, with the disturbance on by default and
    // `full_dirty` set on every dab: 7.2 ms and a full-canvas round trip at
    // 1024², sixty times a second.
    for bend in [false, true] {
        println!("\n-- obstacle mask{} --",
            if bend { " + 绕流 effect" } else { " (cut-out only)" });
        println!("{:>6} {:>12} {:>12} {:>12} {:>10}", "n", "composite", "stroke", "plane", "dirty px");
        for n in [1024usize, 2048, 4096] {
            let mut e = build_obs(n, bend);
            let mut sid = 100u64;
            let step = |e: &mut Engine, sid: &mut u64| {
                *sid += 1;
                e.stroke(&[(0.5, 0.5), (0.53, 0.5)], 40.0, 0.8, 1.0, false, "mask", *sid, 1.0);
            };
            // How much one dab invalidates, measured on a clean engine rather
            // than inside the loop: the loop paints the same spot forty-one
            // times, and a mask stamp that has already saturated changes
            // nothing, so every repetition after the first reports zero.
            let px = {
                let mut f = build_obs(n, bend);
                f.stroke(&[(0.5, 0.5), (0.53, 0.5)], 40.0, 0.8, 1.0, false, "mask", 9, 1.0);
                f.composite();
                let (_x, _y, w, h) = f.dirty_rect();
                w * h
            };
            let c = med(5, 41, || {
                step(&mut e, &mut sid);
                let t = std::time::Instant::now();
                e.composite();
                let v = v_ms(t);
                e.clear_dirty();
                v
            });
            let s = med(5, 41, || {
                let t = std::time::Instant::now();
                step(&mut e, &mut sid);
                let v = v_ms(t);
                e.composite();
                e.clear_dirty();
                v
            });
            // The plane alone, which is what a mask edit forces every dab.
            let plane = {
                let l = e.layers.iter().find(|l| l.p.kind == LayerKind::Obstacle).unwrap();
                let m = l.mask.as_ref().unwrap();
                let d = disturbance_amount(&l.p.effects);
                if d <= 0.0 {
                    0.0
                } else {
                    med(5, 41, || {
                        let t = std::time::Instant::now();
                        let p = skyflow_lib::engine::ops::obstacle_alpha_plane(m, d);
                        std::hint::black_box(&p);
                        v_ms(t)
                    })
                }
            };
            println!("{:>6} {:>12.3} {:>12.3} {:>12.3} {:>10}", n, c, s, plane, px);
        }
    }
}

fn v_ms(t: std::time::Instant) -> f32 {
    t.elapsed().as_secs_f32() * 1000.0
}

/// An engine with a painted obstacle mask. `bend` hangs the 绕流 effect on it,
/// which is the only thing that makes an obstacle more than a cut-out.
fn build_obs(n: usize, bend: bool) -> Engine {
    let mut e = Engine::new(n);
    let obs = e.add_layer(LayerKind::Obstacle);
    e.active = obs.clone();
    e.stroke(&[(0.25, 0.25), (0.3, 0.25)], 120.0, 0.5, 1.0, false, "mask", 1, 1.0);
    if bend {
        e.set_effects(&obs, vec![LayerEffect::disturbance(0.5)]);
    }
    e.composite();
    e.clear_dirty();
    e
}
