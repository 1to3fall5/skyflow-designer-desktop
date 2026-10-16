//! Layer effects — the `fx` badge on a layer row.
//!
//! Photoshop draws a line between what a layer *is* and what is *done to* it.
//! Opacity is the first: it is in the layer panel, because it is how much of
//! the layer you let through. Blur is the second: it is not a property of the
//! pixels, it is something applied to them afterwards, and it belongs in the
//! list of effects you can add, disable and remove without ever touching the
//! pixels themselves.
//!
//! So an effect is a *record on the layer*, not a field that means "some
//! blur". That is what lets a layer carry several, what lets one be switched
//! off while keeping its settings, and what makes "add an effect" an action
//! rather than a slider appearing.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectKind {
    /// Softens the layer's own pixels before they are composited.
    Blur,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct LayerEffect {
    pub kind: EffectKind,
    /// Off keeps the settings. That is the whole point of a list: you can
    /// A/B an effect without losing the number you tuned it to.
    pub enabled: bool,
    /// Strength in the effect's own units — a blur radius in canvas pixels.
    /// An effect with no dial ignores it.
    pub amount: f32,
}

impl LayerEffect {
    pub fn blur(radius: f32) -> Self {
        LayerEffect { kind: EffectKind::Blur, enabled: true, amount: radius }
    }
}

pub fn kind_name(k: &EffectKind) -> &'static str {
    match k {
        EffectKind::Blur => "blur",
    }
}

/**
 * The blur radius these effects ask for, `0` for none.
 *
 * Two blur effects is a mistake rather than a feature, so the larger wins
 * instead of the two stacking — compounding them would give a radius neither
 * slider says, which is worse than picking one.
 */
pub fn blur_amount(fx: &[LayerEffect]) -> f32 {
    fx.iter()
        .filter(|e| e.enabled && e.kind == EffectKind::Blur)
        .map(|e| e.amount)
        .fold(0.0, f32::max)
        .max(0.0)
}
