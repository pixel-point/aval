//! Pure ring arc planning — port of `packages/graph/src/ring-plan.ts`.
//!
//! Graph install / tick reducer remains in Dart (`aval_graph` package) for now;
//! this crate locks the ring geometry math for Rust hosts (WASM / native).

use std::collections::HashMap;

/// Which arc a ring prefers when both directions are equally long.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TieBreak {
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingDefinition {
    pub id: String,
    pub states: Vec<String>,
    pub cyclic: bool,
    pub tie_break: TieBreak,
    pub max_chained_steps: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingArc {
    pub direction: TieBreak,
    /// Ordered landings; last entry is the requested target.
    pub states: Vec<String>,
}

/// Choose the shorter arc between two members of one ring.
pub fn plan_ring_arc(ring: &RingDefinition, from: &str, to: &str) -> Option<RingArc> {
    let length = ring.states.len();
    let from_index = ring.states.iter().position(|s| s == from)?;
    let to_index = ring.states.iter().position(|s| s == to)?;
    if from_index == to_index {
        return None;
    }

    let (forward, backward) = if ring.cyclic {
        (
            (to_index + length - from_index) % length,
            (from_index + length - to_index) % length,
        )
    } else {
        let f = if to_index > from_index {
            to_index - from_index
        } else {
            usize::MAX
        };
        let b = if from_index > to_index {
            from_index - to_index
        } else {
            usize::MAX
        };
        (f, b)
    };
    if forward == usize::MAX && backward == usize::MAX {
        return None;
    }

    let direction = if forward < backward {
        TieBreak::Forward
    } else if backward < forward {
        TieBreak::Backward
    } else {
        ring.tie_break
    };
    let distance = if direction == TieBreak::Forward {
        forward
    } else {
        backward
    };
    let offset: isize = if direction == TieBreak::Forward { 1 } else { -1 };
    let mut states = Vec::with_capacity(distance);
    for step in 1..=distance {
        let index = ((from_index as isize + step as isize * offset).rem_euclid(length as isize))
            as usize;
        states.push(ring.states[index].clone());
    }
    Some(RingArc { direction, states })
}

/// Direct neighbour edge map: from → (to → edge_id).
pub type DirectEdges = HashMap<String, HashMap<String, String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RingRoute {
    None,
    TooLong {
        ring_id: String,
        distance: usize,
    },
    Arc {
        ring_id: String,
        direction: TieBreak,
        states: Vec<String>,
        /// Edge ids along the arc, one per landing.
        step_edge_ids: Vec<String>,
    },
}

/// Resolve authored step edges that walk `from` → `to` along the first capable ring.
pub fn resolve_ring_route(
    rings_by_state: &HashMap<String, Vec<RingDefinition>>,
    direct_edges: &DirectEdges,
    from: &str,
    to: &str,
) -> RingRoute {
    let mut refused: Option<(String, usize)> = None;
    let Some(rings) = rings_by_state.get(from) else {
        return RingRoute::None;
    };
    for ring in rings {
        let Some(arc) = plan_ring_arc(ring, from, to) else {
            continue;
        };
        if arc.states.len() > ring.max_chained_steps {
            refused.get_or_insert_with(|| (ring.id.clone(), arc.states.len()));
            continue;
        }
        let mut step_edge_ids = Vec::with_capacity(arc.states.len());
        let mut cursor = from.to_string();
        let mut ok = true;
        for state in &arc.states {
            match direct_edges.get(&cursor).and_then(|m| m.get(state)) {
                Some(edge_id) => {
                    step_edge_ids.push(edge_id.clone());
                    cursor = state.clone();
                }
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        return RingRoute::Arc {
            ring_id: ring.id.clone(),
            direction: arc.direction,
            states: arc.states,
            step_edge_ids,
        };
    }
    match refused {
        Some((ring_id, distance)) => RingRoute::TooLong { ring_id, distance },
        None => RingRoute::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facing_ring(tie_break: TieBreak, cyclic: bool, max_chained: usize) -> RingDefinition {
        RingDefinition {
            id: "facing.walk".into(),
            states: vec![
                "walk_n".into(),
                "walk_ne".into(),
                "walk_e".into(),
                "walk_se".into(),
                "walk_s".into(),
                "walk_sw".into(),
                "walk_w".into(),
                "walk_nw".into(),
            ],
            cyclic,
            tie_break,
            max_chained_steps: max_chained,
        }
    }

    #[test]
    fn shorter_arc_and_landings() {
        let ring = facing_ring(TieBreak::Forward, true, 4);
        let arc = plan_ring_arc(&ring, "walk_n", "walk_e").unwrap();
        assert_eq!(arc.direction, TieBreak::Forward);
        assert_eq!(arc.states, vec!["walk_ne", "walk_e"]);
        let arc = plan_ring_arc(&ring, "walk_n", "walk_w").unwrap();
        assert_eq!(arc.direction, TieBreak::Backward);
        assert_eq!(arc.states, vec!["walk_nw", "walk_w"]);
    }

    #[test]
    fn half_turn_tie_break() {
        let forward = facing_ring(TieBreak::Forward, true, 4);
        let backward = facing_ring(TieBreak::Backward, true, 4);
        assert_eq!(
            plan_ring_arc(&forward, "walk_n", "walk_s")
                .unwrap()
                .direction,
            TieBreak::Forward
        );
        assert_eq!(
            plan_ring_arc(&backward, "walk_n", "walk_s")
                .unwrap()
                .direction,
            TieBreak::Backward
        );
    }

    #[test]
    fn non_cyclic_no_wrap() {
        let line = facing_ring(TieBreak::Forward, false, 16);
        assert!(plan_ring_arc(&line, "walk_n", "walk_n").is_none());
        assert!(plan_ring_arc(&line, "walk_n", "sit").is_none());
        let arc = plan_ring_arc(&line, "walk_nw", "walk_ne").unwrap();
        assert_eq!(
            arc.states,
            vec![
                "walk_w", "walk_sw", "walk_s", "walk_se", "walk_e", "walk_ne"
            ]
        );
    }
}
