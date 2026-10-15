//! Owned block+sky light engine for the dedicated light-worker.
//!
//! ABI: `push_event` → `step(budget_ms)` → `poll_completed_publication`.
//! Publications are versioned and copy-out packed 2048-byte channels.
//! `sky=15` is never written as an authoritative seed.
//! Sky and block are independent channels. Sky sources skip UP.

use std::collections::{HashMap, HashSet, VecDeque};

use wasm_bindgen::prelude::*;

use crate::chunk_parser_common::{BLOCK_SECTION_VOLUME, LIGHT_SECTION_BUFFER_BYTES};

pub const AIR: u16 = 0;
#[cfg(test)]
pub const STONE: u16 = 1;
#[cfg(test)]
pub const TORCH: u16 = 2;
#[cfg(test)]
pub const WATER: u16 = 3;
#[cfg(test)]
pub const LEAVES: u16 = 4;
#[cfg(test)]
pub const SLAB_BOTTOM: u16 = 5;
#[cfg(test)]
pub const SLAB_TOP: u16 = 6;
#[cfg(test)]
pub const SLAB_DOUBLE: u16 = 7;
#[cfg(test)]
pub const STAIR: u16 = 8;
#[cfg(test)]
pub const GLASS: u16 = 9;

const DIRS: [(i32, i32, i32); 6] = [
    (1, 0, 0),
    (-1, 0, 0),
    (0, 1, 0),
    (0, -1, 0),
    (0, 0, 1),
    (0, 0, -1),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SectionAvailability {
    Unloaded,
    Loaded,
    LightOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LightChannel {
    Block,
    Sky,
}

#[derive(Clone, Debug)]
pub enum ServerLightKind {
    Omitted,
    Empty,
    Data(Vec<u8>),
}

#[derive(Clone, Debug)]
pub enum LightEvent {
    IngestBlockSection {
        sx: i32,
        sy: i32,
        sz: i32,
        states: Vec<u16>,
    },
    SetAvailability {
        sx: i32,
        sy: i32,
        sz: i32,
        availability: SectionAvailability,
    },
    ServerLight {
        sx: i32,
        sy: i32,
        sz: i32,
        channel: LightChannel,
        kind: ServerLightKind,
    },
    BlockChange {
        x: i32,
        y: i32,
        z: i32,
        state_id: u16,
    },
    UnloadColumn {
        sx: i32,
        sz: i32,
    },
}

#[derive(Clone, Debug)]
pub struct PublishedSection {
    pub sx: i32,
    pub sy: i32,
    pub sz: i32,
    pub block_light: Vec<u8>,
    pub sky_light: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct LightPublication {
    pub world_generation: u64,
    pub publication_version: u64,
    pub sections: Vec<PublishedSection>,
}

#[derive(Clone)]
struct Section {
    availability: SectionAvailability,
    states: Option<Vec<u16>>,
    /// Solver working block light (packed 2048).
    block_light: Vec<u8>,
    sky_light: Vec<u8>,
    /// Last accepted server block-light payload (omitted leaves this as-is).
    accepted_block: Option<Vec<u8>>,
    accepted_sky: Option<Vec<u8>>,
}

impl Section {
    fn new(availability: SectionAvailability) -> Self {
        Self {
            availability,
            states: None,
            block_light: vec![0; LIGHT_SECTION_BUFFER_BYTES],
            sky_light: vec![0; LIGHT_SECTION_BUFFER_BYTES],
            accepted_block: None,
            accepted_sky: None,
        }
    }
}

type SectionKey = (i32, i32, i32);

pub struct LightEngine {
    world_min_y: i32,
    world_height: i32,
    world_generation: u64,
    publication_version: u64,
    emission: Vec<u8>,
    /// Raw vanilla getLightBlock per stateId. Decay uses max(1, lightBlock).
    /// Sky *source* stops when lightBlock != 0 (water/leaves), not when decay opacity is 1.
    light_block: Vec<u8>,
    /// 2×2×2 occupancy (bit = x + 2*z + 4*y). Empty unless canOcclude && useShapeForLightOcclusion.
    occupancy: Vec<u8>,
    /// Overworld default: compute sky. Nether/end turn this off and leave sky uncomputed.
    sky_light_enabled: bool,
    sections: HashMap<SectionKey, Section>,
    pending: VecDeque<LightEvent>,
    decrease_q: VecDeque<(i32, i32, i32, u8)>,
    increase_q: VecDeque<(i32, i32, i32, u8)>,
    /// Sky queues are independent of block light. `bool` is skip-up (vanilla sky source).
    sky_decrease_q: VecDeque<(i32, i32, i32, u8, bool)>,
    sky_increase_q: VecDeque<(i32, i32, i32, u8, bool)>,
    /// Publication set only — never a solver guard and never "skip seed".
    changed_for_publication: HashSet<SectionKey>,
    changed_sky: HashSet<SectionKey>,
    check_dedup: HashSet<(i32, i32, i32)>,
    sky_check_dedup: HashSet<(i32, i32, i32)>,
    transaction_open: bool,
    ready_publication: Option<LightPublication>,
    /// Events remaining in the current transaction's snapshot. New pushes stay for the next batch.
    waiting_this_batch: usize,
    pending_sky_xz: VecDeque<(i32, i32)>,
    pending_sky_xz_set: HashSet<(i32, i32)>,
    /// Derived sky-source lowest Y per world (x,z). Not a cell map and not a mirror world.
    sky_source_lowest: HashMap<(i32, i32), i32>,
    #[cfg(test)]
    sky_column_updates: u32,
    #[cfg(test)]
    sky_source_scan_rows: std::cell::Cell<u64>,
}

impl LightEngine {
    pub fn new(world_min_y: i32, world_height: i32) -> Self {
        Self {
            world_min_y,
            world_height,
            world_generation: 1,
            publication_version: 0,
            emission: Vec::new(),
            light_block: Vec::new(),
            occupancy: Vec::new(),
            sky_light_enabled: true,
            sections: HashMap::new(),
            pending: VecDeque::new(),
            decrease_q: VecDeque::new(),
            increase_q: VecDeque::new(),
            sky_decrease_q: VecDeque::new(),
            sky_increase_q: VecDeque::new(),
            changed_for_publication: HashSet::new(),
            changed_sky: HashSet::new(),
            check_dedup: HashSet::new(),
            sky_check_dedup: HashSet::new(),
            transaction_open: false,
            ready_publication: None,
            waiting_this_batch: 0,
            pending_sky_xz: VecDeque::new(),
            pending_sky_xz_set: HashSet::new(),
            sky_source_lowest: HashMap::new(),
            #[cfg(test)]
            sky_column_updates: 0,
            #[cfg(test)]
            sky_source_scan_rows: std::cell::Cell::new(0),
        }
    }

    pub fn set_light_tables(&mut self, emission: &[u8], light_block: &[u8]) {
        self.emission = emission.to_vec();
        self.light_block = light_block.to_vec();
    }

    pub fn set_occlusion_table(&mut self, occupancy: &[u8]) {
        self.occupancy = occupancy.to_vec();
    }

    /// Dimensions without sky light (nether/end) leave the sky channel uncomputed.
    pub fn set_sky_light_enabled(&mut self, enabled: bool) {
        if self.sky_light_enabled != enabled {
            self.sky_source_lowest.clear();
        }
        self.sky_light_enabled = enabled;
    }

    pub fn push_event(&mut self, event: LightEvent) {
        self.pending.push_back(event);
    }

    /// Process pending events and decrease-first queues until `budget_ms` elapses.
    /// Returns true if work remains. Does not publish a half-finished transaction.
    pub fn step(&mut self, budget_ms: f64) -> bool {
        let start = now_ms();
        if self.drain_waiting_events(start, Some(budget_ms)) {
            return true;
        }

        let has_queue = self.has_queue_work();
        if budget_ms <= 0.0 && has_queue {
            return true;
        }

        while let Some((x, y, z, level)) = self.decrease_q.pop_front() {
            self.propagate_decrease(x, y, z, level);
            if now_ms() - start >= budget_ms {
                return true;
            }
        }
        while let Some((x, y, z, level, skip_up)) = self.sky_decrease_q.pop_front() {
            self.propagate_sky_decrease(x, y, z, level, skip_up);
            if now_ms() - start >= budget_ms {
                return true;
            }
        }
        while let Some((x, y, z, level)) = self.increase_q.pop_front() {
            self.propagate_increase(x, y, z, level);
            if now_ms() - start >= budget_ms {
                return true;
            }
        }
        while let Some((x, y, z, level, skip_up)) = self.sky_increase_q.pop_front() {
            self.propagate_sky_increase(x, y, z, level, skip_up);
            if now_ms() - start >= budget_ms {
                return true;
            }
        }

        self.finish_transaction_if_idle();
        self.has_remaining_work()
    }

    /// Deterministic slice: apply events, then at most `max_nodes` queue pops.
    /// `max_nodes == 0` applies events only. Does not use wall-clock time.
    pub fn step_nodes(&mut self, max_nodes: usize) -> bool {
        let start = now_ms();
        let _ = self.drain_waiting_events(start, None);
        let mut left = max_nodes;
        while left > 0 {
            if let Some((x, y, z, level)) = self.decrease_q.pop_front() {
                self.propagate_decrease(x, y, z, level);
                left -= 1;
                continue;
            }
            if let Some((x, y, z, level, skip_up)) = self.sky_decrease_q.pop_front() {
                self.propagate_sky_decrease(x, y, z, level, skip_up);
                left -= 1;
                continue;
            }
            if let Some((x, y, z, level)) = self.increase_q.pop_front() {
                self.propagate_increase(x, y, z, level);
                left -= 1;
                continue;
            }
            if let Some((x, y, z, level, skip_up)) = self.sky_increase_q.pop_front() {
                self.propagate_sky_increase(x, y, z, level, skip_up);
                left -= 1;
                continue;
            }
            break;
        }
        self.finish_transaction_if_idle();
        self.has_remaining_work()
    }

    fn has_queue_work(&self) -> bool {
        !self.decrease_q.is_empty()
            || !self.increase_q.is_empty()
            || !self.sky_decrease_q.is_empty()
            || !self.sky_increase_q.is_empty()
    }

    fn has_remaining_work(&self) -> bool {
        !self.pending.is_empty() || self.prep_in_progress() || self.has_queue_work()
    }

    fn finish_transaction_if_idle(&mut self) {
        if self.transaction_open && !self.has_queue_work() && !self.prep_in_progress() {
            self.publish_completed();
            self.transaction_open = false;
            self.check_dedup.clear();
            self.sky_check_dedup.clear();
        }
    }

    fn prep_in_progress(&self) -> bool {
        self.waiting_this_batch > 0 || !self.pending_sky_xz.is_empty()
    }

    fn batch_in_progress(&self) -> bool {
        self.prep_in_progress() || self.has_queue_work()
    }

    pub fn poll_completed_publication(&mut self) -> Option<LightPublication> {
        self.ready_publication.take()
    }

    pub fn get_block_light(&self, x: i32, y: i32, z: i32) -> u8 {
        self.get_channel(x, y, z, LightChannel::Block)
    }

    pub fn get_sky_light(&self, x: i32, y: i32, z: i32) -> u8 {
        self.get_channel(x, y, z, LightChannel::Sky)
    }

    pub fn section_availability(&self, sx: i32, sy: i32, sz: i32) -> SectionAvailability {
        self.sections
            .get(&(sx, sy, sz))
            .map(|s| s.availability)
            .unwrap_or(SectionAvailability::Unloaded)
    }

    pub fn packed_block_light(&self, sx: i32, sy: i32, sz: i32) -> Option<&[u8]> {
        self.sections.get(&(sx, sy, sz)).map(|s| s.block_light.as_slice())
    }

    fn drain_waiting_events(&mut self, start: f64, budget_ms: Option<f64>) -> bool {
        self.begin_batch_if_needed();
        while self.waiting_this_batch > 0 {
            if let Some(event) = self.pending.pop_front() {
                self.apply_event(event);
            }
            self.waiting_this_batch = self.waiting_this_batch.saturating_sub(1);
            if let Some(budget) = budget_ms {
                if now_ms() - start >= budget {
                    return true;
                }
            }
        }
        self.flush_pending_sky_columns(start, budget_ms)
    }

    fn begin_batch_if_needed(&mut self) {
        if self.batch_in_progress() {
            return;
        }
        self.check_dedup.clear();
        self.sky_check_dedup.clear();
        let known_columns: HashSet<(i32, i32)> =
            self.sections.keys().map(|&(sx, _, sz)| (sx, sz)).collect();
        promote_edit_column(&mut self.pending, |sx, sz| known_columns.contains(&(sx, sz)));
        self.waiting_this_batch = column_admission_len(&self.pending);
    }

    fn invalidate_sky_source_xz(&mut self, x: i32, z: i32) {
        self.sky_source_lowest.remove(&(x, z));
    }

    fn invalidate_sky_source_section(&mut self, sx: i32, sz: i32) {
        for lz in 0..16 {
            for lx in 0..16 {
                self.invalidate_sky_source_xz(sx * 16 + lx as i32, sz * 16 + lz as i32);
            }
        }
    }

    fn sky_source_lowest_y(&mut self, x: i32, z: i32) -> i32 {
        if let Some(&cached) = self.sky_source_lowest.get(&(x, z)) {
            return cached;
        }
        let computed = self.lowest_source_y(x, z);
        self.sky_source_lowest.insert((x, z), computed);
        computed
    }

    fn mark_sky_column_dirty(&mut self, x: i32, z: i32) {
        if !self.sky_light_enabled {
            return;
        }
        if self.pending_sky_xz_set.insert((x, z)) {
            self.pending_sky_xz.push_back((x, z));
        }
    }

    fn mark_sky_columns_in_section(&mut self, sx: i32, sz: i32) {
        for lz in 0..16 {
            for lx in 0..16 {
                self.mark_sky_column_dirty(sx * 16 + lx as i32, sz * 16 + lz as i32);
            }
        }
    }

    fn flush_pending_sky_columns(&mut self, start: f64, budget_ms: Option<f64>) -> bool {
        while let Some((x, z)) = self.pending_sky_xz.pop_front() {
            self.pending_sky_xz_set.remove(&(x, z));
            self.update_sky_column(x, z);
            if let Some(budget) = budget_ms {
                if now_ms() - start >= budget {
                    return true;
                }
            }
        }
        false
    }

    fn apply_event(&mut self, event: LightEvent) {
        match event {
            LightEvent::IngestBlockSection { sx, sy, sz, states } => {
                {
                    let section = self.ensure_section(sx, sy, sz, SectionAvailability::Loaded);
                    section.states = Some(pad_states(states));
                    section.availability = SectionAvailability::Loaded;
                }
                for ly in 0..16 {
                    for lz in 0..16 {
                        for lx in 0..16 {
                            let x = sx * 16 + lx as i32;
                            let y = sy * 16 + ly as i32;
                            let z = sz * 16 + lz as i32;
                            if self.emission_at(x, y, z) > 0 || self.get_block_light(x, y, z) > 0 {
                                self.check_loaded_cell(x, y, z);
                            }
                        }
                    }
                }
                self.invalidate_sky_source_section(sx, sz);
                self.wake_section_face_contacts(sx, sy, sz);
                if self.sky_light_enabled {
                    self.mark_sky_columns_in_section(sx, sz);
                }
                self.mark_changed(sx, sy, sz);
            }
            LightEvent::SetAvailability {
                sx,
                sy,
                sz,
                availability,
            } => {
                if availability == SectionAvailability::Unloaded {
                    self.unload_section(sx, sy, sz);
                    return;
                }
                self.invalidate_sky_source_section(sx, sz);
                self.ensure_section(sx, sy, sz, availability).availability = availability;
                self.mark_changed(sx, sy, sz);
            }
            LightEvent::ServerLight {
                sx,
                sy,
                sz,
                channel,
                kind,
            } => self.apply_server_light(sx, sy, sz, channel, kind),
            LightEvent::BlockChange { x, y, z, state_id } => {
                self.apply_block_change(x, y, z, state_id);
            }
            LightEvent::UnloadColumn { sx, sz } => {
                self.invalidate_sky_source_section(sx, sz);
                let keys: Vec<SectionKey> = self
                    .sections
                    .keys()
                    .copied()
                    .filter(|key| key.0 == sx && key.2 == sz)
                    .collect();
                for (usx, usy, usz) in &keys {
                    self.reconcile_unloading_section(*usx, *usy, *usz);
                }
                for (usx, usy, usz) in keys {
                    self.remove_section_storage(usx, usy, usz);
                }
                self.world_generation = self.world_generation.saturating_add(1);
                self.mark_transaction();
            }
        }
    }

    fn apply_block_change(&mut self, x: i32, y: i32, z: i32, state_id: u16) {
        if !self.in_world(x, y, z) {
            return;
        }
        let (sx, sy, sz) = section_key(x, y, z);
        let old_light = self.get_block_light(x, y, z);
        {
            let Some(section) = self.sections.get_mut(&(sx, sy, sz)) else {
                return;
            };
            let Some(states) = section.states.as_mut() else {
                return;
            };
            states[block_index(x, y, z)] = state_id;
        }
        let emission = self.emission_of(state_id);
        self.invalidate_sky_source_xz(x, z);
        self.mark_changed(sx, sy, sz);

        if emission < old_light {
            self.set_block_light(x, y, z, 0);
            self.decrease_q.push_back((x, y, z, old_light));
            if emission > 0 {
                self.increase_q.push_back((x, y, z, emission));
            }
        } else if emission > old_light {
            self.set_block_light(x, y, z, emission);
            self.increase_q.push_back((x, y, z, emission));
        } else if emission > 0 {
            self.set_block_light(x, y, z, emission);
            self.increase_q.push_back((x, y, z, emission));
        } else if old_light == 0 && self.block_neighbor_level(x, y, z) > 1 {
            // Same pull as sky: opening a path (old=emission=0) re-spreads from a lit neighbor.
            self.decrease_q.push_back((x, y, z, 1));
        }
        self.mark_sky_column_dirty(x, z);
    }

    fn apply_server_light(&mut self, sx: i32, sy: i32, sz: i32, channel: LightChannel, kind: ServerLightKind) {
        match kind {
            ServerLightKind::Omitted => {}
            ServerLightKind::Empty => {
                let zeros = vec![0u8; LIGHT_SECTION_BUFFER_BYTES];
                self.accept_and_reconcile_server(sx, sy, sz, channel, &zeros);
            }
            ServerLightKind::Data(data) => {
                if data.len() != LIGHT_SECTION_BUFFER_BYTES {
                    return;
                }
                self.accept_and_reconcile_server(sx, sy, sz, channel, &data);
            }
        }
    }

    fn accept_and_reconcile_server(&mut self, sx: i32, sy: i32, sz: i32, channel: LightChannel, packed: &[u8]) {
        let availability = self.section_availability(sx, sy, sz);
        {
            let section = self.ensure_section(
                sx,
                sy,
                sz,
                if availability == SectionAvailability::Unloaded {
                    SectionAvailability::LightOnly
                } else {
                    availability
                },
            );
            match channel {
                LightChannel::Block => section.accepted_block = Some(packed.to_vec()),
                LightChannel::Sky => section.accepted_sky = Some(packed.to_vec()),
            }
        }
        if channel == LightChannel::Sky {
            self.invalidate_sky_source_section(sx, sz);
        }

        let availability = self.section_availability(sx, sy, sz);
        let mut changed = Vec::new();
        for ly in 0..16 {
            for lz in 0..16 {
                for lx in 0..16 {
                    let x = sx * 16 + lx as i32;
                    let y = sy * 16 + ly as i32;
                    let z = sz * 16 + lz as i32;
                    if !self.in_world(x, y, z) {
                        continue;
                    }
                    let old = self.get_channel(x, y, z, channel);
                    let new = nibble_at(packed, lx, ly, lz);
                    self.write_working(x, y, z, channel, new);
                    if old != new {
                        changed.push((x, y, z, old, new));
                    }
                }
            }
        }

        if channel == LightChannel::Sky && !self.sky_light_enabled {
            self.mark_sky_changed(sx, sy, sz);
            return;
        }

        match availability {
            SectionAvailability::LightOnly | SectionAvailability::Unloaded => {
                for (x, y, z, old, new) in changed {
                    self.enqueue_boundary_influence(x, y, z, channel, old, new);
                }
                if channel == LightChannel::Sky {
                    self.update_sky_columns_in_section(sx, sz);
                }
            }
            SectionAvailability::Loaded => {
                if channel == LightChannel::Block {
                    for (x, y, z, _old, _new) in changed {
                        self.check_loaded_cell(x, y, z);
                    }
                } else {
                    self.update_sky_columns_in_section(sx, sz);
                }
            }
        }
        if channel == LightChannel::Sky {
            self.mark_sky_changed(sx, sy, sz);
        } else {
            self.mark_changed(sx, sy, sz);
        }
    }

    fn unload_section(&mut self, sx: i32, sy: i32, sz: i32) {
        if !self.sections.contains_key(&(sx, sy, sz)) {
            return;
        }
        self.invalidate_sky_source_section(sx, sz);
        self.reconcile_unloading_section(sx, sy, sz);
        self.remove_section_storage(sx, sy, sz);
    }

    fn remove_section_storage(&mut self, sx: i32, sy: i32, sz: i32) {
        self.sections.remove(&(sx, sy, sz));
        self.changed_for_publication.remove(&(sx, sy, sz));
        self.changed_sky.remove(&(sx, sy, sz));
        self.mark_transaction();
    }

    /// Lost support from a removed section: decrease remaining Loaded contacts.
    /// Unknown after unload is not written as a known-zero wall.
    fn reconcile_unloading_section(&mut self, sx: i32, sy: i32, sz: i32) {
        for (dx, dy, dz) in DIRS {
            let nsx = sx + dx;
            let nsy = sy + dy;
            let nsz = sz + dz;
            if self.section_availability(nsx, nsy, nsz) != SectionAvailability::Loaded {
                continue;
            }
            for (x, y, z) in section_face_cells(sx, sy, sz, dx, dy, dz) {
                if !self.in_world(x, y, z) {
                    continue;
                }
                let old_block = self
                    .known_boundary_light(x, y, z, LightChannel::Block)
                    .unwrap_or_else(|| self.get_block_light(x, y, z));
                if old_block > 0 {
                    self.enqueue_boundary_influence(x, y, z, LightChannel::Block, old_block, 0);
                }
                if self.sky_light_enabled {
                    let old_sky = self
                        .known_boundary_light(x, y, z, LightChannel::Sky)
                        .unwrap_or_else(|| self.get_sky_light(x, y, z));
                    if old_sky > 0 {
                        self.enqueue_boundary_influence(x, y, z, LightChannel::Sky, old_sky, 0);
                    }
                }
            }
        }
    }

    /// Ingest/load contact: dark face cells pull from a lit Loaded neighbor or LIGHT_ONLY boundary.
    fn wake_section_face_contacts(&mut self, sx: i32, sy: i32, sz: i32) {
        for (dx, dy, dz) in DIRS {
            match self.section_availability(sx + dx, sy + dy, sz + dz) {
                SectionAvailability::Unloaded => continue,
                SectionAvailability::Loaded | SectionAvailability::LightOnly => {
                    for (x, y, z) in section_face_cells(sx, sy, sz, dx, dy, dz) {
                        if self.in_world(x, y, z) {
                            self.pull_block_from_neighbors(x, y, z);
                        }
                    }
                }
            }
        }
    }

    fn pull_block_from_neighbors(&mut self, x: i32, y: i32, z: i32) {
        if !self.can_write(x, y, z) {
            return;
        }
        if self.emission_at(x, y, z) > 0 || self.get_block_light(x, y, z) > 0 {
            return;
        }
        if self.block_neighbor_level(x, y, z) > 1 {
            self.decrease_q.push_back((x, y, z, 1));
        }
    }

    fn block_neighbor_level(&self, x: i32, y: i32, z: i32) -> u8 {
        let mut max_level = 0u8;
        for (dx, dy, dz) in DIRS {
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            let level = self
                .known_boundary_light(nx, ny, nz, LightChannel::Block)
                .unwrap_or_else(|| self.get_block_light(nx, ny, nz));
            max_level = max_level.max(level);
        }
        max_level
    }

    fn check_loaded_cell(&mut self, x: i32, y: i32, z: i32) {
        if !self.check_dedup.insert((x, y, z)) {
            return;
        }
        if self.section_availability_at(x, y, z) != SectionAvailability::Loaded {
            return;
        }
        let emission = self.emission_at(x, y, z);
        let stored = self.get_block_light(x, y, z);
        if emission < stored {
            self.set_block_light(x, y, z, 0);
            self.decrease_q.push_back((x, y, z, stored));
        }
        if emission > 0 {
            if self.get_block_light(x, y, z) < emission {
                self.set_block_light(x, y, z, emission);
            }
            self.increase_q.push_back((x, y, z, emission));
        }
    }

    fn enqueue_boundary_influence(&mut self, x: i32, y: i32, z: i32, channel: LightChannel, old: u8, new: u8) {
        match channel {
            LightChannel::Block => {
                if new > 0 {
                    self.increase_q.push_back((x, y, z, new));
                }
                if old > new {
                    for (dx, dy, dz) in DIRS {
                        let nx = x + dx;
                        let ny = y + dy;
                        let nz = z + dz;
                        if self.section_availability_at(nx, ny, nz) != SectionAvailability::Loaded {
                            continue;
                        }
                        let stored = self.get_block_light(nx, ny, nz);
                        if stored == 0 {
                            continue;
                        }
                        if stored <= old.saturating_sub(1) {
                            self.set_block_light(nx, ny, nz, 0);
                            self.decrease_q.push_back((nx, ny, nz, stored));
                            let emission = self.emission_at(nx, ny, nz);
                            if emission > 0 {
                                self.increase_q.push_back((nx, ny, nz, emission));
                            }
                        } else {
                            self.increase_q.push_back((nx, ny, nz, stored));
                        }
                    }
                }
            }
            LightChannel::Sky => {
                if new > 0 {
                    self.sky_increase_q.push_back((x, y, z, new, new == 15));
                }
                if old > new {
                    for (dx, dy, dz) in DIRS {
                        let nx = x + dx;
                        let ny = y + dy;
                        let nz = z + dz;
                        if self.section_availability_at(nx, ny, nz) != SectionAvailability::Loaded {
                            continue;
                        }
                        let stored = self.get_sky_light(nx, ny, nz);
                        if stored == 0 {
                            continue;
                        }
                        if stored <= old.saturating_sub(1) {
                            self.set_sky_light(nx, ny, nz, 0);
                            self.sky_decrease_q.push_back((nx, ny, nz, stored, stored == 15));
                            let emission = self.sky_emission_at(nx, ny, nz);
                            if emission > 0 {
                                self.sky_increase_q.push_back((nx, ny, nz, emission, true));
                            }
                        } else {
                            self.sky_increase_q.push_back((nx, ny, nz, stored, false));
                        }
                    }
                }
            }
        }
    }

    fn propagate_decrease(&mut self, x: i32, y: i32, z: i32, from_level: u8) {
        for (dx, dy, dz) in DIRS {
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            if let Some(boundary) = self.known_boundary_light(nx, ny, nz, LightChannel::Block) {
                if boundary > 0 {
                    self.increase_q.push_back((nx, ny, nz, boundary));
                }
                continue;
            }
            if !self.can_write(nx, ny, nz) {
                continue;
            }
            let stored = self.get_block_light(nx, ny, nz);
            if stored == 0 {
                continue;
            }
            if stored <= from_level.saturating_sub(1) {
                self.set_block_light(nx, ny, nz, 0);
                self.decrease_q.push_back((nx, ny, nz, stored));
                let emission = self.emission_at(nx, ny, nz);
                if emission > 0 {
                    self.increase_q.push_back((nx, ny, nz, emission));
                }
            } else {
                self.increase_q.push_back((nx, ny, nz, stored));
            }
        }
    }

    fn propagate_increase(&mut self, x: i32, y: i32, z: i32, level: u8) {
        if let Some(boundary) = self.known_boundary_light(x, y, z, LightChannel::Block) {
            if boundary == 0 {
                return;
            }
            self.spread_increase(x, y, z, boundary.min(level));
            return;
        }
        let stored = self.get_block_light(x, y, z);
        let emission = self.emission_at(x, y, z);
        let supported = stored.max(emission);
        if level > supported {
            if stored <= 1 {
                return;
            }
            self.spread_increase(x, y, z, stored);
            return;
        }
        if stored < emission {
            self.set_block_light(x, y, z, emission);
        }
        let from = self.get_block_light(x, y, z);
        self.spread_increase(x, y, z, from);
    }

    fn spread_increase(&mut self, x: i32, y: i32, z: i32, level: u8) {
        for (dx, dy, dz) in DIRS {
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            if !self.can_write(nx, ny, nz) {
                continue;
            }
            if self.shape_occludes(x, y, z, nx, ny, nz, dx, dy, dz) {
                continue;
            }
            let next = level.saturating_sub(self.opacity_at(nx, ny, nz));
            let stored = self.get_block_light(nx, ny, nz);
            if next > stored {
                self.set_block_light(nx, ny, nz, next);
                if next > 1 {
                    self.increase_q.push_back((nx, ny, nz, next));
                }
            }
        }
    }

    fn update_sky_columns_in_section(&mut self, sx: i32, sz: i32) {
        self.mark_sky_columns_in_section(sx, sz);
    }

    fn update_sky_column(&mut self, x: i32, z: i32) {
        if !self.sky_light_enabled {
            return;
        }
        #[cfg(test)]
        {
            self.sky_column_updates = self.sky_column_updates.saturating_add(1);
        }
        let lowest = self.sky_source_lowest_y(x, z);
        let max_y = self.world_min_y + self.world_height;
        for y in (self.world_min_y..max_y).rev() {
            if self.section_availability_at(x, y, z) == SectionAvailability::Loaded {
                self.sky_check_dedup.remove(&(x, y, z));
                self.check_sky_cell_with_lowest(x, y, z, lowest);
            }
        }
    }

    fn check_sky_cell_with_lowest(&mut self, x: i32, y: i32, z: i32, lowest: i32) {
        if !self.sky_check_dedup.insert((x, y, z)) {
            return;
        }
        if self.section_availability_at(x, y, z) != SectionAvailability::Loaded {
            return;
        }
        let emission = if !self.sky_occludes(x, y, z) && y >= lowest { 15 } else { 0 };
        let stored = self.get_sky_light(x, y, z);
        if emission < stored {
            self.set_sky_light(x, y, z, 0);
            self.sky_decrease_q.push_back((x, y, z, stored, stored == 15));
        }
        if emission > 0 {
            if self.get_sky_light(x, y, z) < emission {
                self.set_sky_light(x, y, z, emission);
            }
            self.sky_increase_q.push_back((x, y, z, emission, true));
        } else if stored == 0 && self.sky_neighbor_level(x, y, z) > 1 {
            self.sky_decrease_q.push_back((x, y, z, 1, false));
        }
    }

    fn sky_neighbor_level(&self, x: i32, y: i32, z: i32) -> u8 {
        let mut max_level = 0u8;
        for (dx, dy, dz) in DIRS {
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            let level = self
                .known_boundary_light(nx, ny, nz, LightChannel::Sky)
                .unwrap_or_else(|| self.get_sky_light(nx, ny, nz));
            max_level = max_level.max(level);
        }
        max_level
    }

    fn sky_emission_at(&mut self, x: i32, y: i32, z: i32) -> u8 {
        if self.is_sky_source(x, y, z) {
            15
        } else {
            0
        }
    }

    fn is_sky_source(&mut self, x: i32, y: i32, z: i32) -> bool {
        if !self.sky_light_enabled || !self.in_world(x, y, z) {
            return false;
        }
        if self.section_availability_at(x, y, z) != SectionAvailability::Loaded {
            return false;
        }
        if self.sky_occludes(x, y, z) {
            return false;
        }
        y >= self.sky_source_lowest_y(x, z)
    }

    /// Vanilla sky *source* stops on true light-blocking: getLightBlock() != 0.
    /// Air/glass/slabs are 0 (column stays 15). Water/leaves are 1 (below is not 15).
    fn sky_occludes(&self, x: i32, y: i32, z: i32) -> bool {
        self.light_block_at(x, y, z) != 0
    }

    /// Lowest Y in this column that is a sky source, or i32::MAX if the column has no sky.
    /// Unknown (unloaded / LIGHT_ONLY without data) is not treated as 15.
    fn lowest_source_y(&self, x: i32, z: i32) -> i32 {
        if !self.sky_light_enabled {
            return i32::MAX;
        }
        let max_y = self.world_min_y + self.world_height - 1;
        let mut connected = false;
        let mut lowest = i32::MAX;
        for y in (self.world_min_y..=max_y).rev() {
            #[cfg(test)]
            {
                self.sky_source_scan_rows
                    .set(self.sky_source_scan_rows.get().saturating_add(1));
            }
            match self.section_availability_at(x, y, z) {
                SectionAvailability::Unloaded => {
                    if connected {
                        break;
                    }
                }
                SectionAvailability::LightOnly => match self.known_boundary_light(x, y, z, LightChannel::Sky) {
                    Some(15) => {
                        connected = true;
                    }
                    Some(_) | None => {
                        if connected {
                            break;
                        }
                    }
                },
                SectionAvailability::Loaded => {
                    if y == max_y {
                        if self.sky_occludes(x, y, z) {
                            break;
                        }
                        connected = true;
                        lowest = y;
                        continue;
                    }
                    if !connected {
                        continue;
                    }
                    if self.sky_occludes(x, y, z) {
                        break;
                    }
                    lowest = y;
                }
            }
        }
        lowest
    }

    fn propagate_sky_decrease(&mut self, x: i32, y: i32, z: i32, from_level: u8, skip_up: bool) {
        for (dx, dy, dz) in DIRS {
            if skip_up && dy == 1 {
                continue;
            }
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            if let Some(boundary) = self.known_boundary_light(nx, ny, nz, LightChannel::Sky) {
                if boundary > 0 {
                    self.sky_increase_q.push_back((nx, ny, nz, boundary, boundary == 15));
                }
                continue;
            }
            if !self.can_write(nx, ny, nz) {
                continue;
            }
            let stored = self.get_sky_light(nx, ny, nz);
            if stored == 0 {
                continue;
            }
            if stored <= from_level.saturating_sub(1) {
                self.set_sky_light(nx, ny, nz, 0);
                self.sky_decrease_q.push_back((nx, ny, nz, stored, stored == 15));
                let emission = self.sky_emission_at(nx, ny, nz);
                if emission > 0 {
                    self.sky_increase_q.push_back((nx, ny, nz, emission, true));
                }
            } else {
                self.sky_increase_q.push_back((nx, ny, nz, stored, false));
            }
        }
    }

    fn propagate_sky_increase(&mut self, x: i32, y: i32, z: i32, level: u8, skip_up: bool) {
        if let Some(boundary) = self.known_boundary_light(x, y, z, LightChannel::Sky) {
            if boundary == 0 {
                return;
            }
            self.spread_sky_increase(x, y, z, boundary.min(level), skip_up || boundary == 15);
            return;
        }
        let stored = self.get_sky_light(x, y, z);
        let emission = self.sky_emission_at(x, y, z);
        let supported = stored.max(emission);
        if level > supported {
            if stored <= 1 {
                return;
            }
            self.spread_sky_increase(x, y, z, stored, false);
            return;
        }
        if stored < emission {
            self.set_sky_light(x, y, z, emission);
        }
        let from = self.get_sky_light(x, y, z);
        self.spread_sky_increase(x, y, z, from, skip_up || emission == 15);
    }

    fn spread_sky_increase(&mut self, x: i32, y: i32, z: i32, level: u8, skip_up: bool) {
        for (dx, dy, dz) in DIRS {
            if skip_up && dy == 1 {
                continue;
            }
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            if !self.can_write(nx, ny, nz) {
                continue;
            }
            if self.shape_occludes(x, y, z, nx, ny, nz, dx, dy, dz) {
                continue;
            }
            let next = level.saturating_sub(self.opacity_at(nx, ny, nz));
            let stored = self.get_sky_light(nx, ny, nz);
            if next > stored {
                self.set_sky_light(nx, ny, nz, next);
                if next > 1 {
                    self.sky_increase_q.push_back((nx, ny, nz, next, false));
                }
            }
        }
    }

    fn publish_completed(&mut self) {
        if self.changed_for_publication.is_empty() {
            return;
        }
        self.publication_version = self.publication_version.saturating_add(1);
        let keys: Vec<SectionKey> = self.changed_for_publication.drain().collect();
        let sky_keys = std::mem::take(&mut self.changed_sky);
        let mut sections = Vec::with_capacity(keys.len());
        for (sx, sy, sz) in keys {
            if let Some(section) = self.sections.get(&(sx, sy, sz)) {
                let sky = if sky_keys.contains(&(sx, sy, sz)) {
                    Some(section.sky_light.clone())
                } else {
                    None
                };
                sections.push(PublishedSection {
                    sx,
                    sy,
                    sz,
                    block_light: section.block_light.clone(),
                    sky_light: sky,
                });
            }
        }
        if sections.is_empty() {
            return;
        }
        let incoming = LightPublication {
            world_generation: self.world_generation,
            publication_version: self.publication_version,
            sections,
        };
        match self.ready_publication.as_mut() {
            Some(existing) => {
                existing.publication_version = incoming.publication_version;
                existing.world_generation = incoming.world_generation;
                existing.sections.extend(incoming.sections);
            }
            None => self.ready_publication = Some(incoming),
        }
    }

    fn mark_changed(&mut self, sx: i32, sy: i32, sz: i32) {
        self.changed_for_publication.insert((sx, sy, sz));
        self.mark_transaction();
    }

    fn mark_sky_changed(&mut self, sx: i32, sy: i32, sz: i32) {
        self.changed_sky.insert((sx, sy, sz));
        self.mark_changed(sx, sy, sz);
    }

    fn mark_transaction(&mut self) {
        self.transaction_open = true;
    }

    fn ensure_section(
        &mut self,
        sx: i32,
        sy: i32,
        sz: i32,
        availability: SectionAvailability,
    ) -> &mut Section {
        self.sections
            .entry((sx, sy, sz))
            .or_insert_with(|| Section::new(availability))
    }

    fn get_channel(&self, x: i32, y: i32, z: i32, channel: LightChannel) -> u8 {
        let (sx, sy, sz) = section_key(x, y, z);
        let Some(section) = self.sections.get(&(sx, sy, sz)) else {
            return 0;
        };
        nibble_at(channel_buf(section, channel), local(x), local(y), local(z))
    }

    fn set_block_light(&mut self, x: i32, y: i32, z: i32, value: u8) {
        if self.section_availability_at(x, y, z) != SectionAvailability::Loaded {
            return;
        }
        self.write_working(x, y, z, LightChannel::Block, value);
    }

    fn set_sky_light(&mut self, x: i32, y: i32, z: i32, value: u8) {
        if self.section_availability_at(x, y, z) != SectionAvailability::Loaded {
            return;
        }
        self.write_working(x, y, z, LightChannel::Sky, value);
    }

    fn write_working(&mut self, x: i32, y: i32, z: i32, channel: LightChannel, value: u8) {
        let (sx, sy, sz) = section_key(x, y, z);
        let Some(section) = self.sections.get_mut(&(sx, sy, sz)) else {
            return;
        };
        set_nibble(channel_buf_mut(section, channel), local(x), local(y), local(z), value);
        self.changed_for_publication.insert((sx, sy, sz));
        if channel == LightChannel::Sky {
            self.changed_sky.insert((sx, sy, sz));
        }
    }

    fn known_boundary_light(&self, x: i32, y: i32, z: i32, channel: LightChannel) -> Option<u8> {
        let (sx, sy, sz) = section_key(x, y, z);
        let section = self.sections.get(&(sx, sy, sz))?;
        if section.availability != SectionAvailability::LightOnly {
            return None;
        }
        let accepted = match channel {
            LightChannel::Block => section.accepted_block.is_some(),
            LightChannel::Sky => section.accepted_sky.is_some(),
        };
        if !accepted {
            return None;
        }
        Some(nibble_at(channel_buf(section, channel), local(x), local(y), local(z)))
    }

    fn can_write(&self, x: i32, y: i32, z: i32) -> bool {
        self.in_world(x, y, z) && self.section_availability_at(x, y, z) == SectionAvailability::Loaded
    }

    fn section_availability_at(&self, x: i32, y: i32, z: i32) -> SectionAvailability {
        let (sx, sy, sz) = section_key(x, y, z);
        self.section_availability(sx, sy, sz)
    }

    fn in_world(&self, _x: i32, y: i32, _z: i32) -> bool {
        y >= self.world_min_y && y < self.world_min_y + self.world_height
    }

    fn emission_at(&self, x: i32, y: i32, z: i32) -> u8 {
        self.emission_of(self.state_at(x, y, z))
    }

    fn opacity_at(&self, x: i32, y: i32, z: i32) -> u8 {
        self.opacity_of(self.state_at(x, y, z))
    }

    fn light_block_at(&self, x: i32, y: i32, z: i32) -> u8 {
        self.light_block_of(self.state_at(x, y, z))
    }

    fn state_at(&self, x: i32, y: i32, z: i32) -> u16 {
        let (sx, sy, sz) = section_key(x, y, z);
        self.sections
            .get(&(sx, sy, sz))
            .and_then(|section| section.states.as_ref())
            .map(|states| states[block_index(x, y, z)])
            .unwrap_or(AIR)
    }

    fn emission_of(&self, state_id: u16) -> u8 {
        self.emission.get(state_id as usize).copied().unwrap_or(0).min(15)
    }

    fn light_block_of(&self, state_id: u16) -> u8 {
        self.light_block.get(state_id as usize).copied().unwrap_or(0).min(15)
    }

    /// Neighbor spread: vanilla getOpacity = max(1, getLightBlock()). Air still costs 1.
    fn opacity_of(&self, state_id: u16) -> u8 {
        self.light_block_of(state_id).max(1)
    }

    fn occupancy_of(&self, state_id: u16) -> u8 {
        self.occupancy.get(state_id as usize).copied().unwrap_or(0)
    }

    /// 1.17.1 LayerLightEngine: faceShapeOccludes(from.dir, to.opposite).
    /// Full cube (0xFF) matches Shapes.block() identity. Otherwise OR of the 3D
    /// occupancy "slices" must fill the cube. Isolated slabs/stairs vs air do not occlude.
    fn shape_occludes(&self, x: i32, y: i32, z: i32, nx: i32, ny: i32, nz: i32, dx: i32, dy: i32, dz: i32) -> bool {
        let from = self.face_shape(self.occupancy_of(self.state_at(x, y, z)), dx, dy, dz);
        let to = self.face_shape(self.occupancy_of(self.state_at(nx, ny, nz)), -dx, -dy, -dz);
        if from == 0xFF || to == 0xFF {
            return true;
        }
        if from == 0 && to == 0 {
            return false;
        }
        from | to == 0xFF
    }

    fn face_shape(&self, occ: u8, dx: i32, dy: i32, dz: i32) -> u8 {
        if occ == 0 || occ == 0xFF {
            return occ;
        }
        let mask = if dx > 0 {
            0b1010_1010
        } else if dx < 0 {
            0b0101_0101
        } else if dy > 0 {
            0b1111_0000
        } else if dy < 0 {
            0b0000_1111
        } else if dz > 0 {
            0b1100_1100
        } else if dz < 0 {
            0b0011_0011
        } else {
            0
        };
        if occ & mask == 0 {
            0
        } else {
            occ
        }
    }
}

#[cfg(test)]
mod test_clock {
    use std::cell::Cell;

    thread_local! {
        static NOW: Cell<Option<f64>> = const { Cell::new(None) };
        static STEP: Cell<f64> = const { Cell::new(0.0) };
    }

    pub struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            NOW.with(|c| c.set(None));
            STEP.with(|c| c.set(0.0));
        }
    }

    pub fn start(now: f64, step: f64) -> Guard {
        NOW.with(|c| c.set(Some(now)));
        STEP.with(|c| c.set(step));
        Guard
    }

    pub fn advance_and_read() -> Option<f64> {
        let t = NOW.with(|c| c.get())?;
        let step = STEP.with(|c| c.get());
        NOW.with(|c| c.set(Some(t + step)));
        Some(t)
    }
}

fn now_ms() -> f64 {
    #[cfg(test)]
    {
        if let Some(t) = test_clock::advance_and_read() {
            return t;
        }
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
}

fn event_column(event: &LightEvent) -> (i32, i32) {
    match event {
        LightEvent::IngestBlockSection { sx, sz, .. }
        | LightEvent::SetAvailability { sx, sz, .. }
        | LightEvent::ServerLight { sx, sz, .. }
        | LightEvent::UnloadColumn { sx, sz } => (*sx, *sz),
        LightEvent::BlockChange { x, z, .. } => (x.div_euclid(16), z.div_euclid(16)),
    }
}

/// FIFO prefix of one column's connected load/availability/seed/edit events.
fn column_admission_len(pending: &VecDeque<LightEvent>) -> usize {
    let Some(first) = pending.front() else {
        return 0;
    };
    let column = event_column(first);
    pending
        .iter()
        .take_while(|event| event_column(event) == column)
        .count()
}

/// Promote the earliest edit column, then its queued 3x3 neighborhood.
/// Block light (level <= 15, decay >= 1) cannot reach beyond these columns.
/// Preserve each column's event order and unrelated bulk order. Admission
/// remains one column at a time; missing neighbors are never invented.
fn promote_edit_column(pending: &mut VecDeque<LightEvent>, column_known: impl Fn(i32, i32) -> bool) {
    if pending.is_empty() {
        return;
    }
    let head_column = event_column(pending.front().unwrap());
    // A bounded prefix scan turns startup bulk depth into interactive latency:
    // edits beyond that prefix cannot be promoted until the bulk drains.
    let Some(edit_idx) = pending
        .iter()
        .position(|event| matches!(event, LightEvent::BlockChange { .. }))
    else {
        return;
    };
    let edit_column = event_column(&pending[edit_idx]);
    if edit_column == head_column && edit_idx >= column_admission_len(pending) {
        // Keep the initial head prefix as its own transaction. The trailing
        // edit and its dependencies can jump bulk at the next boundary.
        return;
    }
    let original: Vec<LightEvent> = pending.drain(..).collect();
    let has_ingest = original.iter().any(|event| {
        event_column(event) == edit_column && matches!(event, LightEvent::IngestBlockSection { .. })
    });
    if !has_ingest && !column_known(edit_column.0, edit_column.1) {
        pending.extend(original);
        return;
    }
    let (extracted, rest): (Vec<LightEvent>, Vec<LightEvent>) = original
        .into_iter()
        .partition(|event| event_column(event) == edit_column);
    let (neighbors, bulk): (Vec<LightEvent>, Vec<LightEvent>) = rest
        .into_iter()
        .partition(|event| {
            let (sx, sz) = event_column(event);
            sx.abs_diff(edit_column.0) <= 1 && sz.abs_diff(edit_column.1) <= 1
        });
    pending.extend(extracted);
    // Retain dependencies after the edit leaves the queue. Ingest's face
    // contact wake-up propagates the light as each neighbor becomes known.
    pending.extend(neighbors);
    pending.extend(bulk);
}

fn section_key(x: i32, y: i32, z: i32) -> SectionKey {
    (x.div_euclid(16), y.div_euclid(16), z.div_euclid(16))
}

fn local(v: i32) -> usize {
    v.rem_euclid(16) as usize
}

fn block_index(x: i32, y: i32, z: i32) -> usize {
    local(x) + local(z) * 16 + local(y) * 256
}

/// Cells of section (sx,sy,sz) on the face toward (dx,dy,dz).
fn section_face_cells(
    sx: i32,
    sy: i32,
    sz: i32,
    dx: i32,
    dy: i32,
    dz: i32,
) -> impl Iterator<Item = (i32, i32, i32)> {
    let (lx0, lx1, ly0, ly1, lz0, lz1) = match (dx, dy, dz) {
        (1, 0, 0) => (15, 16, 0, 16, 0, 16),
        (-1, 0, 0) => (0, 1, 0, 16, 0, 16),
        (0, 1, 0) => (0, 16, 15, 16, 0, 16),
        (0, -1, 0) => (0, 16, 0, 1, 0, 16),
        (0, 0, 1) => (0, 16, 0, 16, 15, 16),
        (0, 0, -1) => (0, 16, 0, 16, 0, 1),
        _ => (0, 0, 0, 0, 0, 0),
    };
    (ly0..ly1).flat_map(move |ly| {
        (lz0..lz1).flat_map(move |lz| {
            (lx0..lx1).map(move |lx| (sx * 16 + lx, sy * 16 + ly, sz * 16 + lz))
        })
    })
}

fn pad_states(mut states: Vec<u16>) -> Vec<u16> {
    if states.len() < BLOCK_SECTION_VOLUME {
        states.resize(BLOCK_SECTION_VOLUME, AIR);
    }
    states.truncate(BLOCK_SECTION_VOLUME);
    states
}

fn channel_buf(section: &Section, channel: LightChannel) -> &[u8] {
    match channel {
        LightChannel::Block => &section.block_light,
        LightChannel::Sky => &section.sky_light,
    }
}

fn channel_buf_mut(section: &mut Section, channel: LightChannel) -> &mut [u8] {
    match channel {
        LightChannel::Block => &mut section.block_light,
        LightChannel::Sky => &mut section.sky_light,
    }
}

fn set_nibble(packed: &mut [u8], lx: usize, ly: usize, lz: usize, value: u8) {
    let local = (ly << 8) | (lz << 4) | lx;
    let byte = local >> 1;
    let n = value & 0x0f;
    if local & 1 == 0 {
        packed[byte] = (packed[byte] & 0xf0) | n;
    } else {
        packed[byte] = (packed[byte] & 0x0f) | (n << 4);
    }
}

pub fn pack_uniform_section(value: u8) -> Vec<u8> {
    let n = value & 0x0f;
    vec![n | (n << 4); LIGHT_SECTION_BUFFER_BYTES]
}

pub fn nibble_at(packed: &[u8], lx: usize, ly: usize, lz: usize) -> u8 {
    let local = (ly << 8) | (lz << 4) | lx;
    let byte = packed[local >> 1];
    if local & 1 == 0 {
        byte & 0x0f
    } else {
        byte >> 4
    }
}

#[wasm_bindgen]
pub struct JsLightEngine {
    inner: LightEngine,
}

#[wasm_bindgen]
impl JsLightEngine {
    #[wasm_bindgen(constructor)]
    pub fn js_new(world_min_y: i32, world_height: i32) -> JsLightEngine {
        JsLightEngine {
            inner: LightEngine::new(world_min_y, world_height),
        }
    }

    #[wasm_bindgen(js_name = setLightTables)]
    pub fn js_set_light_tables(&mut self, emission: &[u8], opacity: &[u8]) {
        self.inner.set_light_tables(emission, opacity);
    }

    #[wasm_bindgen(js_name = setOcclusionTable)]
    pub fn js_set_occlusion_table(&mut self, occupancy: &[u8]) {
        self.inner.set_occlusion_table(occupancy);
    }

    #[wasm_bindgen(js_name = pushEvent)]
    pub fn js_push_event(&mut self, event: JsValue) {
        match event_from_js(&event) {
            Ok(ev) => self.inner.push_event(ev),
            Err(msg) => wasm_bindgen::throw_str(&msg),
        }
    }

    pub fn step(&mut self, budget_ms: f64) -> bool {
        self.inner.step(budget_ms)
    }

    #[wasm_bindgen(js_name = pollCompletedPublication)]
    pub fn js_poll_completed_publication(&mut self) -> JsValue {
        match self.inner.poll_completed_publication() {
            Some(publication) => publication_to_js(&publication),
            None => JsValue::NULL,
        }
    }

    #[wasm_bindgen(js_name = getBlockLight)]
    pub fn js_get_block_light(&self, x: i32, y: i32, z: i32) -> u8 {
        self.inner.get_block_light(x, y, z)
    }

    #[wasm_bindgen(js_name = getSkyLight)]
    pub fn js_get_sky_light(&self, x: i32, y: i32, z: i32) -> u8 {
        self.inner.get_sky_light(x, y, z)
    }

    #[wasm_bindgen(js_name = setSkyLightEnabled)]
    pub fn js_set_sky_light_enabled(&mut self, enabled: bool) {
        self.inner.set_sky_light_enabled(enabled);
    }
}

fn event_from_js(event: &JsValue) -> Result<LightEvent, String> {
    let kind = js_string(event, "type")?;
    match kind.as_str() {
        "ingestBlockSection" => {
            let states = js_u16_array(event, "states").unwrap_or_default();
            Ok(LightEvent::IngestBlockSection {
                sx: js_i32(event, "sx")?,
                sy: js_i32(event, "sy")?,
                sz: js_i32(event, "sz")?,
                states,
            })
        }
        "setAvailability" => Ok(LightEvent::SetAvailability {
            sx: js_i32(event, "sx")?,
            sy: js_i32(event, "sy")?,
            sz: js_i32(event, "sz")?,
            availability: match js_string(event, "availability")?.as_str() {
                "loaded" => SectionAvailability::Loaded,
                "lightOnly" => SectionAvailability::LightOnly,
                "unloaded" => SectionAvailability::Unloaded,
                other => return Err(format!("unknown availability {other}")),
            },
        }),
        "serverLight" => {
            let channel = match js_string(event, "channel")?.as_str() {
                "sky" => LightChannel::Sky,
                _ => LightChannel::Block,
            };
            let kind = match js_string(event, "kind")?.as_str() {
                "omitted" => ServerLightKind::Omitted,
                "empty" => ServerLightKind::Empty,
                "data" => ServerLightKind::Data(js_u8_array(event, "data")?),
                other => return Err(format!("unknown server light kind {other}")),
            };
            Ok(LightEvent::ServerLight {
                sx: js_i32(event, "sx")?,
                sy: js_i32(event, "sy")?,
                sz: js_i32(event, "sz")?,
                channel,
                kind,
            })
        }
        "blockChange" => Ok(LightEvent::BlockChange {
            x: js_i32(event, "x")?,
            y: js_i32(event, "y")?,
            z: js_i32(event, "z")?,
            state_id: js_i32(event, "stateId")? as u16,
        }),
        "unloadColumn" => Ok(LightEvent::UnloadColumn {
            sx: js_i32(event, "sx")?,
            sz: js_i32(event, "sz")?,
        }),
        other => Err(format!("unknown light event {other}")),
    }
}

fn publication_to_js(publication: &LightPublication) -> JsValue {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("worldGeneration"),
        &JsValue::from_f64(publication.world_generation as f64),
    )
    .unwrap();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("publicationVersion"),
        &JsValue::from_f64(publication.publication_version as f64),
    )
    .unwrap();
    let list = js_sys::Array::new();
    for section in &publication.sections {
        let item = js_sys::Object::new();
        js_sys::Reflect::set(&item, &JsValue::from_str("sx"), &JsValue::from_f64(section.sx as f64)).unwrap();
        js_sys::Reflect::set(&item, &JsValue::from_str("sy"), &JsValue::from_f64(section.sy as f64)).unwrap();
        js_sys::Reflect::set(&item, &JsValue::from_str("sz"), &JsValue::from_f64(section.sz as f64)).unwrap();
        let block = js_sys::Uint8Array::new_with_length(section.block_light.len() as u32);
        block.copy_from(&section.block_light);
        js_sys::Reflect::set(&item, &JsValue::from_str("blockLight"), &block).unwrap();
        if let Some(sky) = &section.sky_light {
            let sky_arr = js_sys::Uint8Array::new_with_length(sky.len() as u32);
            sky_arr.copy_from(sky);
            js_sys::Reflect::set(&item, &JsValue::from_str("skyLight"), &sky_arr).unwrap();
        }
        list.push(&item);
    }
    js_sys::Reflect::set(&obj, &JsValue::from_str("sections"), &list).unwrap();
    obj.into()
}

fn js_i32(obj: &JsValue, key: &str) -> Result<i32, String> {
    let value = js_sys::Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| format!("missing {key}"))?;
    value.as_f64().map(|n| n as i32).ok_or_else(|| format!("{key} is not a number"))
}

fn js_string(obj: &JsValue, key: &str) -> Result<String, String> {
    let value = js_sys::Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| format!("missing {key}"))?;
    value.as_string().ok_or_else(|| format!("{key} is not a string"))
}

fn js_u8_array(obj: &JsValue, key: &str) -> Result<Vec<u8>, String> {
    let value = js_sys::Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| format!("missing {key}"))?;
    let array = js_sys::Uint8Array::new(&value);
    Ok(array.to_vec())
}

fn js_u16_array(obj: &JsValue, key: &str) -> Result<Vec<u16>, String> {
    let value = js_sys::Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| format!("missing {key}"))?;
    if value.is_undefined() || value.is_null() {
        return Err(format!("missing {key}"));
    }
    let array = js_sys::Uint16Array::new(&value);
    Ok(array.to_vec())
}

#[cfg(test)]
fn default_test_tables() -> (Vec<u8>, Vec<u8>) {
    let mut emission = vec![0u8; 16];
    let mut light_block = vec![0u8; 16];
    emission[TORCH as usize] = 14;
    light_block[STONE as usize] = 15;
    (emission, light_block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_v16_v17::{parse_update_light_v17, NUM_SECTIONS_V17};
    use std::fs;
    use std::path::Path;

    fn engine() -> LightEngine {
        let mut e = LightEngine::new(0, 256);
        let (emission, opacity) = default_test_tables();
        e.set_light_tables(&emission, &opacity);
        e
    }

    fn air_section() -> Vec<u16> {
        vec![AIR; BLOCK_SECTION_VOLUME]
    }

    fn load_section(e: &mut LightEngine, sx: i32, sy: i32, sz: i32, states: Vec<u16>) {
        e.push_event(LightEvent::IngestBlockSection { sx, sy, sz, states });
        e.push_event(LightEvent::SetAvailability {
            sx,
            sy,
            sz,
            availability: SectionAvailability::Loaded,
        });
    }

    fn finish(e: &mut LightEngine) -> Option<LightPublication> {
        let mut remaining = true;
        let mut guard = 0;
        while remaining && guard < 64 {
            remaining = e.step(1_000.0);
            guard += 1;
        }
        e.poll_completed_publication()
    }

    fn drain_until_publication(e: &mut LightEngine) -> Option<LightPublication> {
        let mut guard = 0;
        while guard < 64 {
            let remaining = e.step(1_000.0);
            if let Some(publication) = e.poll_completed_publication() {
                return Some(publication);
            }
            if !remaining {
                break;
            }
            guard += 1;
        }
        None
    }

    fn sample(e: &LightEngine) -> [u8; 3] {
        [
            e.get_block_light(8, 64, 8),
            e.get_block_light(9, 64, 8),
            e.get_block_light(8, 65, 8),
        ]
    }

    fn zero_seed_section(e: &mut LightEngine, sx: i32, sy: i32, sz: i32) {
        e.push_event(LightEvent::ServerLight {
            sx,
            sy,
            sz,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(pack_uniform_section(0)),
        });
    }

    fn load_air_column_ready(e: &mut LightEngine) {
        load_section(e, 0, 4, 0, air_section());
        finish(e);
    }

    fn place_torch(e: &mut LightEngine) {
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
    }

    fn remove_torch(e: &mut LightEngine) {
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: AIR,
        });
    }

    fn set_light_only_boundary(e: &mut LightEngine, sx: i32, sy: i32, sz: i32, value: u8) {
        e.push_event(LightEvent::SetAvailability {
            sx,
            sy,
            sz,
            availability: SectionAvailability::LightOnly,
        });
        e.push_event(LightEvent::ServerLight {
            sx,
            sy,
            sz,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(pack_uniform_section(value)),
        });
    }

    /// Boundary 14 + 6 Loaded air cells = 13,12,11,10,9,8. Not a spill-cut.
    #[test]
    fn invariant_boundary_14_lights_six_air_cells() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        set_light_only_boundary(&mut e, 1, 4, 0, 14);
        finish(&mut e);
        assert_eq!(e.get_block_light(16, 64, 8), 14, "LIGHT_ONLY boundary stays 14");
        let chain: Vec<u8> = (0..6).map(|i| e.get_block_light(15 - i, 64, 8)).collect();
        assert_eq!(chain, vec![13, 12, 11, 10, 9, 8]);
    }

    /// Replacing the boundary with known zero clears the dependent air.
    #[test]
    fn invariant_boundary_replaced_with_zero_clears_air() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        set_light_only_boundary(&mut e, 1, 4, 0, 14);
        finish(&mut e);
        assert_eq!(e.get_block_light(15, 64, 8), 13);
        set_light_only_boundary(&mut e, 1, 4, 0, 0);
        finish(&mut e);
        assert_eq!(e.get_block_light(16, 64, 8), 0, "known-zero boundary");
        for i in 0..6 {
            assert_eq!(e.get_block_light(15 - i, 64, 8), 0, "air cell {i} must fall with the boundary");
        }
    }

    /// Seeded air without a source or LIGHT_ONLY boundary must not self-sustain.
    #[test]
    fn invariant_seed_without_source_or_boundary_is_zero() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 4,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(pack_uniform_section(14)),
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 0, "seed is a candidate, not a virtual emitter");
        assert_eq!(e.get_block_light(9, 64, 8), 0);
        assert_eq!(e.get_block_light(15, 64, 8), 0);
    }

    /// Sequence 1: torch → seed before the first queue pop. Sliced == continuous.
    #[test]
    fn sequence_torch_then_seed_before_first_pop() {
        let mut continuous = engine();
        load_air_column_ready(&mut continuous);
        place_torch(&mut continuous);
        zero_seed_section(&mut continuous, 0, 4, 0);
        finish(&mut continuous);
        let want = sample(&continuous);
        assert_eq!(want[0], 14, "source must stay 14 after seed-before-pop");
        assert!(want[1] >= 13);
        assert!(want[2] >= 13);

        let mut sliced = engine();
        load_air_column_ready(&mut sliced);
        place_torch(&mut sliced);
        sliced.step_nodes(0);
        zero_seed_section(&mut sliced, 0, 4, 0);
        finish(&mut sliced);
        assert_eq!(sample(&sliced), want, "sliced must match continuous (seed before first pop)");
    }

    /// Sequence 2: torch → one increase-pop → zero-seed → finish. Must not underlight to 12.
    #[test]
    fn sequence_seed_between_slices() {
        let mut continuous = engine();
        load_air_column_ready(&mut continuous);
        place_torch(&mut continuous);
        zero_seed_section(&mut continuous, 0, 4, 0);
        finish(&mut continuous);
        let want = sample(&continuous);
        assert_eq!(want[0], 14, "continuous seed must restore torch emission");

        let mut sliced = engine();
        load_air_column_ready(&mut sliced);
        place_torch(&mut sliced);
        sliced.step_nodes(1);
        zero_seed_section(&mut sliced, 0, 4, 0);
        finish(&mut sliced);
        assert_eq!(sliced.get_block_light(8, 64, 8), 14, "seed between slices must not leave source at 12");
        assert_eq!(sample(&sliced), want, "sliced must match continuous (seed between slices)");
    }

    /// Sequence 3: place then remove in one batch, no seed. Stale increase must not resurrect 14/13.
    #[test]
    fn sequence_place_then_remove_without_seed() {
        let mut continuous = engine();
        load_air_column_ready(&mut continuous);
        place_torch(&mut continuous);
        remove_torch(&mut continuous);
        finish(&mut continuous);
        let want = sample(&continuous);
        assert_eq!(want, [0, 0, 0], "place+remove must end at 0/0, not phantom 14/13");

        let mut sliced = engine();
        load_air_column_ready(&mut sliced);
        place_torch(&mut sliced);
        sliced.step_nodes(1);
        remove_torch(&mut sliced);
        finish(&mut sliced);
        assert_eq!(sample(&sliced), want, "sliced must match continuous (place then remove)");
    }

    /// Sequence 4: seed zeros on a clean section that still has a torch.
    #[test]
    fn sequence_seed_on_clean_section_with_torch() {
        let mut continuous = engine();
        load_air_column_ready(&mut continuous);
        place_torch(&mut continuous);
        finish(&mut continuous);
        assert_eq!(continuous.get_block_light(8, 64, 8), 14);
        zero_seed_section(&mut continuous, 0, 4, 0);
        finish(&mut continuous);
        let want = sample(&continuous);
        assert_eq!(want[0], 14, "clean-section seed must restore emission from stateId");
        assert!(want[1] >= 13);

        let mut sliced = engine();
        load_air_column_ready(&mut sliced);
        place_torch(&mut sliced);
        finish(&mut sliced);
        zero_seed_section(&mut sliced, 0, 4, 0);
        sliced.step_nodes(2);
        finish(&mut sliced);
        assert_eq!(sample(&sliced), want, "sliced must match continuous (seed on clean torch)");
    }

    #[test]
    fn omitted_server_section_is_not_replaced() {
        let mut e = engine();
        set_light_only_boundary(&mut e, 0, 0, 0, 7);
        set_light_only_boundary(&mut e, 0, 1, 0, 3);
        finish(&mut e);

        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 1,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(pack_uniform_section(9)),
        });
        finish(&mut e);

        assert_eq!(e.get_block_light(0, 0, 0), 7, "omitted LIGHT_ONLY neighbor must stay 7");
        assert_eq!(e.get_block_light(0, 16, 0), 9);
    }

    #[test]
    fn empty_server_bit_zeros_section() {
        let mut e = engine();
        set_light_only_boundary(&mut e, 0, 0, 0, 7);
        finish(&mut e);
        assert_eq!(e.get_block_light(1, 1, 1), 7, "known boundary 7");
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 0,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Empty,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(1, 1, 1), 0, "empty-bit is known zero");
    }

    #[test]
    fn torch_place_then_remove_has_no_phantom_light() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        finish(&mut e);

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 14);
        assert!(e.get_block_light(9, 64, 8) >= 13);
        assert!(e.get_block_light(8, 65, 8) >= 13);

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: AIR,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 0);
        assert_eq!(e.get_block_light(9, 64, 8), 0);
        assert_eq!(e.get_block_light(8, 70, 8), 0);
    }

    #[test]
    fn second_source_survives_removal_of_first() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::BlockChange {
            x: 4,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        e.push_event(LightEvent::BlockChange {
            x: 12,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        let mid_before = e.get_block_light(8, 64, 8);
        assert!(mid_before > 0);

        e.push_event(LightEvent::BlockChange {
            x: 4,
            y: 64,
            z: 8,
            state_id: AIR,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(12, 64, 8), 14);
        assert!(e.get_block_light(8, 64, 8) > 0, "overlap must stay lit by the remaining torch");
        assert_eq!(e.get_block_light(4, 64, 8), e.get_block_light(5, 64, 8).saturating_sub(1));
        assert!(e.get_block_light(4, 64, 8) < 14);
    }

    #[test]
    fn step_does_not_publish_mid_transaction() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        e.step(1_000.0);
        let _ = e.poll_completed_publication();

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        let remaining = e.step(0.0);
        assert!(remaining, "queues must still hold work after a zero-ms slice");
        assert!(e.poll_completed_publication().is_none(), "half transaction must not publish");

        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 14);
    }

    #[test]
    fn publication_versions_increase_and_block_only_omits_sky() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        let first = finish(&mut e).expect("ingest publication");
        assert_eq!(first.world_generation, 1);
        assert!(first.publication_version >= 1);
        assert!(first.sections.iter().all(|s| s.sky_light.is_none()), "block-light engine publishes block only");

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        let second = finish(&mut e).expect("torch publication");
        assert_eq!(second.world_generation, first.world_generation);
        assert!(second.publication_version > first.publication_version);
        assert!(second.sections.iter().any(|s| s.sx == 0 && s.sy == 4 && s.sz == 0));
        assert_eq!(second.sections[0].block_light.len(), LIGHT_SECTION_BUFFER_BYTES);
        assert!(second.sections.iter().all(|s| s.sky_light.is_none()));
    }

    #[test]
    fn tables_drive_emission() {
        let mut e = LightEngine::new(0, 256);
        let mut emission = vec![0u8; 16];
        let light_block = vec![0u8; 16];
        emission[TORCH as usize] = 7;
        e.set_light_tables(&emission, &light_block);
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 7);
    }

    #[test]
    fn light_only_without_data_is_not_air() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::SetAvailability {
            sx: 1,
            sy: 4,
            sz: 0,
            availability: SectionAvailability::LightOnly,
        });
        e.push_event(LightEvent::BlockChange {
            x: 15,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        assert_eq!(e.section_availability(1, 4, 0), SectionAvailability::LightOnly);
        assert_eq!(e.get_block_light(15, 64, 8), 14);
        assert_eq!(
            e.get_block_light(16, 64, 8),
            0,
            "LIGHT_ONLY with no accepted data is not writable air"
        );
    }

    #[test]
    fn captured_1_17_1_partial_does_not_wipe_omitted_engine_section() {
        let mut e = engine();
        for sy in 0..NUM_SECTIONS_V17 as i32 {
            if sy == 6 {
                set_light_only_boundary(&mut e, 7, sy, 0, 7);
            } else {
                load_section(&mut e, 7, sy, 0, air_section());
            }
        }
        finish(&mut e);
        assert_eq!(e.get_block_light(112, 96, 0), 7);

        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chunk-packet-fixtures/fixtures/map_chunk/1.17.1/5_0.update_light.bin");
        let packet = fs::read(&path).unwrap_or_else(|_| panic!("missing fixture {:?}", path));
        let parsed = parse_update_light_v17(&packet, NUM_SECTIONS_V17).expect("parse 1.17.1 fixture");
        assert_eq!(parsed.x, 7);
        assert_eq!(parsed.z, 0);

        for sy in 0..NUM_SECTIONS_V17 {
            let bit = sy + 1;
            let word = parsed.empty_block_light_mask.get(0).copied().unwrap_or(0);
            let empty = (word & (1 << bit)) != 0;
            let data = parsed.block_light_mask.get(0).copied().unwrap_or(0) & (1 << bit) != 0;
            if !empty && !data {
                continue;
            }
            e.push_event(LightEvent::ServerLight {
                sx: parsed.x,
                sy: sy as i32,
                sz: parsed.z,
                channel: LightChannel::Block,
                kind: if data {
                    let start = sy * BLOCK_SECTION_VOLUME;
                    ServerLightKind::Data(pack_unpacked(&parsed.block_light[start..start + BLOCK_SECTION_VOLUME]))
                } else {
                    ServerLightKind::Empty
                },
            });
        }
        finish(&mut e);

        assert_eq!(
            e.get_block_light(112, 96, 0),
            7,
            "fixture empty-bits 1-5 must not wipe omitted world section 6"
        );
        assert_eq!(e.get_block_light(112, 0, 0), 0, "empty-bit world section 0 must clear");
    }

    fn pack_unpacked(values: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; LIGHT_SECTION_BUFFER_BYTES];
        for (i, &v) in values.iter().enumerate() {
            let byte = i >> 1;
            if i & 1 == 0 {
                out[byte] = (out[byte] & 0xf0) | (v & 0x0f);
            } else {
                out[byte] = (out[byte] & 0x0f) | ((v & 0x0f) << 4);
            }
        }
        out
    }

    fn top_section_y(e: &LightEngine) -> i32 {
        (e.world_min_y + e.world_height).div_euclid(16) - 1
    }

    fn load_world_top_air(e: &mut LightEngine) {
        let sy = top_section_y(e);
        load_section(e, 0, sy, 0, air_section());
    }

    fn set_sky_only_boundary(e: &mut LightEngine, sx: i32, sy: i32, sz: i32, value: u8) {
        e.push_event(LightEvent::SetAvailability {
            sx,
            sy,
            sz,
            availability: SectionAvailability::LightOnly,
        });
        e.push_event(LightEvent::ServerLight {
            sx,
            sy,
            sz,
            channel: LightChannel::Sky,
            kind: ServerLightKind::Data(pack_uniform_section(value)),
        });
    }

    fn place_stone_roof(e: &mut LightEngine, y: i32, hole: Option<(i32, i32)>) {
        for z in 0..16 {
            for x in 0..16 {
                if hole == Some((x, z)) {
                    continue;
                }
                e.push_event(LightEvent::BlockChange {
                    x,
                    y,
                    z,
                    state_id: STONE,
                });
            }
        }
    }

    fn remove_stone_roof(e: &mut LightEngine, y: i32) {
        for z in 0..16 {
            for x in 0..16 {
                e.push_event(LightEvent::BlockChange {
                    x,
                    y,
                    z,
                    state_id: AIR,
                });
            }
        }
    }

    fn sample_sky(e: &LightEngine, y: i32) -> [u8; 3] {
        [
            e.get_sky_light(8, y, 8),
            e.get_sky_light(9, y, 8),
            e.get_sky_light(8, y - 1, 8),
        ]
    }

    /// Open air at world top is a sky source: the column stays 15 (no downward decay).
    #[test]
    fn sky_open_column_stays_15() {
        let mut e = engine();
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 1;
        assert_eq!(e.get_sky_light(8, y, 8), 15, "world-top air is a sky source");
        assert_eq!(e.get_sky_light(8, y - 15, 8), 15, "unobstructed column does not decay downward");
        assert_eq!(e.get_sky_light(0, y - 7, 0), 15);
    }

    /// A 1-block hole in an opaque roof: 15 down the hole, sideways decay under the roof.
    #[test]
    fn sky_hole_column_stays_15_and_decays_sideways() {
        let mut e = engine();
        load_world_top_air(&mut e);
        finish(&mut e);
        let roof_y = e.world_min_y + e.world_height - 6;
        place_stone_roof(&mut e, roof_y, Some((8, 8)));
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, roof_y, 8), 15, "hole remains a sky source");
        assert_eq!(e.get_sky_light(8, roof_y - 1, 8), 15, "air under the hole stays 15");
        assert_eq!(e.get_sky_light(8, roof_y - 5, 8), 15);
        assert_eq!(e.get_sky_light(9, roof_y - 1, 8), 14, "under-roof neighbor decays");
        assert_eq!(e.get_sky_light(10, roof_y - 1, 8), 13);
        assert_eq!(e.get_sky_light(11, roof_y - 1, 8), 12);
    }

    /// Opaque roof with no hole: everything below goes dark.
    #[test]
    fn sky_opaque_roof_darkens_below() {
        let mut e = engine();
        load_world_top_air(&mut e);
        finish(&mut e);
        let roof_y = e.world_min_y + e.world_height - 6;
        place_stone_roof(&mut e, roof_y, None);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, roof_y + 1, 8), 15, "above the roof stays sky");
        assert_eq!(e.get_sky_light(8, roof_y, 8), 0, "opaque roof is not a source");
        assert_eq!(e.get_sky_light(8, roof_y - 1, 8), 0);
        assert_eq!(e.get_sky_light(0, roof_y - 4, 0), 0);
        assert_eq!(e.get_block_light(8, roof_y - 1, 8), 0, "sky must not write the block channel");
    }

    /// Removing the roof restores sky 15.
    #[test]
    fn sky_remove_roof_restores_column() {
        let mut e = engine();
        load_world_top_air(&mut e);
        finish(&mut e);
        let roof_y = e.world_min_y + e.world_height - 6;
        place_stone_roof(&mut e, roof_y, None);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, roof_y - 1, 8), 0);
        remove_stone_roof(&mut e, roof_y);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, roof_y, 8), 15);
        assert_eq!(e.get_sky_light(8, roof_y - 1, 8), 15);
        assert_eq!(e.get_sky_light(8, roof_y - 5, 8), 15);
    }

    /// LIGHT_ONLY sky 15 is a boundary, not air: it lights a decaying chain into Loaded.
    #[test]
    fn sky_invariant_boundary_15_lights_six_air_cells() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        set_sky_only_boundary(&mut e, 1, 4, 0, 15);
        finish(&mut e);
        assert_eq!(e.get_sky_light(16, 64, 8), 15, "LIGHT_ONLY sky boundary stays 15");
        let chain: Vec<u8> = (0..6).map(|i| e.get_sky_light(15 - i, 64, 8)).collect();
        assert_eq!(chain, vec![14, 13, 12, 11, 10, 9]);
        assert_eq!(e.get_block_light(15, 64, 8), 0, "sky boundary must not fill block light");
    }

    /// Seeded sky without a source or LIGHT_ONLY boundary must not self-sustain.
    #[test]
    fn sky_invariant_seed_without_source_or_boundary_is_zero() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 4,
            sz: 0,
            channel: LightChannel::Sky,
            kind: ServerLightKind::Data(pack_uniform_section(15)),
        });
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 64, 8), 0, "sky seed is a candidate, not a virtual source");
        assert_eq!(e.get_sky_light(9, 64, 8), 0);
        assert_eq!(e.get_sky_light(15, 64, 8), 0);
    }

    /// Unloaded / unknown above a loaded air section is not treated as sky 15.
    #[test]
    fn sky_unknown_above_is_not_source() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 79, 8), 0, "top of a mid-world section is not open sky");
        assert_eq!(e.get_sky_light(8, 64, 8), 0);
    }

    /// LIGHT_ONLY sky 15 above Loaded air continues the source column (15, no downward decay).
    #[test]
    fn sky_light_only_15_above_continues_source_column() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        set_sky_only_boundary(&mut e, 0, 5, 0, 15);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 79, 8), 15);
        assert_eq!(e.get_sky_light(8, 64, 8), 15);
    }

    /// Sliced roof place/remove matches continuous; stale queue entries must not resurrect sky.
    #[test]
    fn sky_sliced_roof_matches_continuous() {
        let roof_y = 250;
        let mut continuous = engine();
        load_world_top_air(&mut continuous);
        finish(&mut continuous);
        place_stone_roof(&mut continuous, roof_y, None);
        finish(&mut continuous);
        let want_dark = sample_sky(&continuous, roof_y - 1);
        assert_eq!(want_dark, [0, 0, 0]);
        remove_stone_roof(&mut continuous, roof_y);
        finish(&mut continuous);
        let want_lit = sample_sky(&continuous, roof_y - 1);
        assert_eq!(want_lit, [15, 15, 15]);

        let mut sliced = engine();
        load_world_top_air(&mut sliced);
        finish(&mut sliced);
        place_stone_roof(&mut sliced, roof_y, None);
        sliced.step_nodes(1);
        finish(&mut sliced);
        assert_eq!(sample_sky(&sliced, roof_y - 1), want_dark, "sliced roof must match continuous");
        remove_stone_roof(&mut sliced, roof_y);
        sliced.step_nodes(3);
        finish(&mut sliced);
        assert_eq!(sample_sky(&sliced, roof_y - 1), want_lit, "sliced restore must match continuous");
    }

    /// Sky seed between slices on a sourced column must not underlight; sliced == continuous.
    #[test]
    fn sky_sliced_seed_on_open_column_matches_continuous() {
        let mut continuous = engine();
        load_world_top_air(&mut continuous);
        finish(&mut continuous);
        continuous.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: top_section_y(&continuous),
            sz: 0,
            channel: LightChannel::Sky,
            kind: ServerLightKind::Data(pack_uniform_section(0)),
        });
        finish(&mut continuous);
        let y = continuous.world_min_y + continuous.world_height - 1;
        let want = sample_sky(&continuous, y);
        assert_eq!(want[0], 15, "zero-seed on open sky must restore sources");

        let mut sliced = engine();
        load_world_top_air(&mut sliced);
        sliced.step_nodes(1);
        sliced.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: top_section_y(&sliced),
            sz: 0,
            channel: LightChannel::Sky,
            kind: ServerLightKind::Data(pack_uniform_section(0)),
        });
        finish(&mut sliced);
        assert_eq!(sample_sky(&sliced, y), want, "sliced sky seed must match continuous");
    }

    #[test]
    fn sky_publication_includes_sky_channel() {
        let mut e = engine();
        load_world_top_air(&mut e);
        let publication = finish(&mut e).expect("sky ingest publication");
        let sy = top_section_y(&e);
        let section = publication
            .sections
            .iter()
            .find(|s| s.sx == 0 && s.sy == sy && s.sz == 0)
            .expect("top section published");
        let sky = section.sky_light.as_ref().expect("sky channel must be published");
        assert_eq!(sky.len(), LIGHT_SECTION_BUFFER_BYTES);
        assert_eq!(nibble_at(sky, 8, 15, 8), 15);
    }

    #[test]
    fn sky_disabled_dimension_stays_uncomputed() {
        let mut e = engine();
        e.set_sky_light_enabled(false);
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 1;
        assert_eq!(e.get_sky_light(8, y, 8), 0, "nether/end must not invent sky 15");
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: top_section_y(&e),
            sz: 0,
            channel: LightChannel::Sky,
            kind: ServerLightKind::Data(pack_uniform_section(15)),
        });
        finish(&mut e);
        assert_eq!(
            e.get_sky_light(8, y, 8),
            15,
            "disabled sky stores seed without turning it into a self-sustaining source column"
        );
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y,
            z: 8,
            state_id: STONE,
        });
        finish(&mut e);
        assert_eq!(
            e.get_sky_light(8, y - 1, 8),
            15,
            "disabled sky must not recompute around a roof"
        );
    }

    /// Raw lightBlock tables: air=0 so the open column is still a sky source.
    fn engine_raw() -> LightEngine {
        let mut e = LightEngine::new(0, 256);
        let mut emission = vec![0u8; 16];
        let mut light_block = vec![0u8; 16];
        emission[TORCH as usize] = 14;
        light_block[STONE as usize] = 15;
        light_block[WATER as usize] = 1;
        light_block[LEAVES as usize] = 1;
        light_block[SLAB_DOUBLE as usize] = 15;
        e.set_light_tables(&emission, &light_block);
        e
    }

    fn place_state_roof(e: &mut LightEngine, y: i32, state_id: u16) {
        for z in 0..16 {
            for x in 0..16 {
                e.push_event(LightEvent::BlockChange { x, y, z, state_id });
            }
        }
    }

    /// Water has raw lightBlock 1: it is not a sky source. Decay still uses max(1, O).
    #[test]
    fn sky_water_stops_source_then_14() {
        let mut e = engine_raw();
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 6;
        place_state_roof(&mut e, y, WATER);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, y + 1, 8), 15, "air above water stays a sky source");
        assert_eq!(e.get_sky_light(8, y, 8), 14, "water itself is 14, not a source 15");
        assert_ne!(e.get_sky_light(8, y - 1, 8), 15, "below water is not an open sky column");
        assert_eq!(e.get_sky_light(8, y - 1, 8), 13);
    }

    /// Leaves are the same class as water: lightBlock 1 stops the source column.
    #[test]
    fn sky_leaves_stop_source_then_14() {
        let mut e = engine_raw();
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 6;
        place_state_roof(&mut e, y, LEAVES);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, y, 8), 14);
        assert_ne!(e.get_sky_light(8, y - 1, 8), 15);
        assert_eq!(e.get_sky_light(8, y - 1, 8), 13);
    }

    /// Glass: lightBlock 0, noOcclusion. Sky source continues (15), unlike a solid cube.
    #[test]
    fn sky_glass_does_not_stop_source() {
        let mut e = engine_raw();
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 6;
        place_state_roof(&mut e, y, GLASS);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, y, 8), 15, "glass is not a light-blocking cube");
        assert_eq!(e.get_sky_light(8, y - 1, 8), 15);
    }

    /// Bottom slab is not a full cube: sky source continues. Double slab / stone do not.
    #[test]
    fn sky_bottom_slab_is_not_a_full_cube() {
        let mut e = engine_raw();
        load_world_top_air(&mut e);
        finish(&mut e);
        let y = e.world_min_y + e.world_height - 6;
        place_state_roof(&mut e, y, SLAB_BOTTOM);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, y, 8), 15, "bottom slab lightBlock 0 keeps the source");
        assert_eq!(e.get_sky_light(8, y - 1, 8), 15, "air under a bottom slab stays 15");

        place_state_roof(&mut e, y, SLAB_DOUBLE);
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, y, 8), 0, "double slab is a full cube");
        assert_eq!(e.get_sky_light(8, y - 1, 8), 0);
    }

    /// Torch emission still pins at 14 with raw air lightBlock 0.
    #[test]
    fn raw_air_still_spreads_torch_14() {
        let mut e = engine_raw();
        load_section(&mut e, 0, 4, 0, air_section());
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 14);
        assert_eq!(e.get_block_light(9, 64, 8), 13);
    }

    fn engine_raw_with_shapes() -> LightEngine {
        let mut e = engine_raw();
        let mut occupancy = vec![0u8; 16];
        occupancy[SLAB_BOTTOM as usize] = 0x0F;
        occupancy[SLAB_TOP as usize] = 0xF0;
        occupancy[STAIR as usize] = 0x3F;
        e.set_occlusion_table(&occupancy);
        e
    }

    fn stone_section() -> Vec<u16> {
        vec![STONE; BLOCK_SECTION_VOLUME]
    }

    /// Stone tunnel along X so light cannot path around the pair under test.
    fn load_x_tunnel(e: &mut LightEngine) {
        load_section(e, 0, 4, 0, stone_section());
        for x in 7..=11 {
            e.push_event(LightEvent::BlockChange {
                x,
                y: 64,
                z: 8,
                state_id: AIR,
            });
        }
        e.push_event(LightEvent::BlockChange {
            x: 7,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
    }

    /// Complementary bottom+top slabs fill the cube: vanilla faceShapeOccludes, light does not pass.
    #[test]
    fn face_bottom_and_top_slab_block_horizontal_light() {
        let mut e = engine_raw_with_shapes();
        load_x_tunnel(&mut e);
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: SLAB_BOTTOM,
        });
        e.push_event(LightEvent::BlockChange {
            x: 9,
            y: 64,
            z: 8,
            state_id: SLAB_TOP,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(7, 64, 8), 14);
        assert_eq!(e.get_block_light(8, 64, 8), 13, "bottom slab vs air does not occlude");
        assert_eq!(e.get_block_light(9, 64, 8), 0, "bottom+top slab pair occludes");
        assert_eq!(e.get_block_light(10, 64, 8), 0);
    }

    /// Two bottom slabs do not fill the cube — light goes through the open top half.
    #[test]
    fn face_two_bottom_slabs_do_not_block() {
        let mut e = engine_raw_with_shapes();
        load_x_tunnel(&mut e);
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: SLAB_BOTTOM,
        });
        e.push_event(LightEvent::BlockChange {
            x: 9,
            y: 64,
            z: 8,
            state_id: SLAB_BOTTOM,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 13);
        assert_eq!(e.get_block_light(9, 64, 8), 12);
        assert_eq!(e.get_block_light(10, 64, 8), 11);
    }

    /// A stair is not air: with a complementary top slab it occludes; air + top slab does not.
    #[test]
    fn face_stair_is_not_air() {
        let mut stair = engine_raw_with_shapes();
        load_x_tunnel(&mut stair);
        stair.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: STAIR,
        });
        stair.push_event(LightEvent::BlockChange {
            x: 9,
            y: 64,
            z: 8,
            state_id: SLAB_TOP,
        });
        finish(&mut stair);
        assert_eq!(stair.get_block_light(8, 64, 8), 13);
        assert_eq!(stair.get_block_light(9, 64, 8), 0, "stair ∪ top slab fills the cube");

        let mut air = engine_raw_with_shapes();
        load_x_tunnel(&mut air);
        air.push_event(LightEvent::BlockChange {
            x: 9,
            y: 64,
            z: 8,
            state_id: SLAB_TOP,
        });
        finish(&mut air);
        assert_eq!(air.get_block_light(8, 64, 8), 13, "air west of the top slab");
        assert_eq!(air.get_block_light(9, 64, 8), 12, "top slab vs air does not occlude");
    }

    /// Glass: lightBlock 0 and empty occupancy. Spread matches air, unlike a full cube.
    #[test]
    fn face_glass_does_not_occlude_spread() {
        let mut e = engine_raw_with_shapes();
        load_x_tunnel(&mut e);
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: GLASS,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(8, 64, 8), 13);
        assert_eq!(e.get_block_light(9, 64, 8), 12);
        assert_eq!(e.get_block_light(10, 64, 8), 11);
    }

    /// Loading 16 sections of one column must update each (x,z) sky column once, not 16 times.
    #[test]
    fn ingest_many_sections_dedupes_sky_columns() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        e.step_nodes(0);
        assert_eq!(
            e.sky_column_updates, 256,
            "16 air sections must not rescan the same 256 columns 16 times"
        );
    }

    /// step(5) must yield during prep: a later step finishes with the same lighting as continuous.
    #[test]
    fn drain_stops_mid_batch_and_later_step_matches_continuous() {
        let mut continuous = engine();
        for sy in 12..16 {
            load_section(&mut continuous, 0, sy, 0, air_section());
        }
        finish(&mut continuous);
        let y = continuous.world_min_y + continuous.world_height - 1;
        let want = [
            continuous.get_sky_light(8, y, 8),
            continuous.get_sky_light(8, y - 15, 8),
            continuous.get_sky_light(8, 200, 8),
        ];
        assert_eq!(want[0], 15);

        let mut sliced = engine();
        for sy in 12..16 {
            load_section(&mut sliced, 0, sy, 0, air_section());
        }
        {
            let _clock = super::test_clock::start(0.0, 10.0);
            let remaining = sliced.step(5.0);
            assert!(remaining, "budgeted prep must report remaining work");
            assert_eq!(
                sliced.section_availability(0, 15, 0),
                SectionAvailability::Unloaded,
                "one 5ms step must not ingest the whole column"
            );
        }
        finish(&mut sliced);
        assert_eq!(sliced.get_sky_light(8, y, 8), want[0]);
        assert_eq!(sliced.get_sky_light(8, y - 15, 8), want[1]);
        assert_eq!(sliced.get_sky_light(8, 200, 8), want[2]);
    }

    fn x_air_tunnel() -> Vec<u16> {
        let mut states = stone_section();
        for x in 0..16 {
            states[block_index(x, 64, 8)] = AIR;
        }
        states
    }

    fn block_along_x(e: &LightEngine, start: i32, count: i32) -> Vec<u8> {
        (0..count).map(|i| e.get_block_light(start + i, 64, 8)).collect()
    }

    /// Torch already lit; removing a non-emitting stone must pull block light into the opened path.
    #[test]
    fn opening_block_light_path() {
        let mut e = engine();
        let mut states = x_air_tunnel();
        states[block_index(4, 64, 8)] = TORCH;
        states[block_index(8, 64, 8)] = STONE;
        load_section(&mut e, 0, 4, 0, states);
        finish(&mut e);
        assert_eq!(block_along_x(&e, 4, 8), vec![14, 13, 12, 11, 0, 0, 0, 0]);

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: AIR,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(9, 64, 8), 9, "light must enter opened path");
        assert_eq!(block_along_x(&e, 4, 8), vec![14, 13, 12, 11, 10, 9, 8, 7]);
    }

    /// Same opening must not depend on draining the whole BFS in one step.
    #[test]
    fn opening_block_light_path_sliced_matches_continuous() {
        let setup = |e: &mut LightEngine| {
            let mut states = x_air_tunnel();
            states[block_index(4, 64, 8)] = TORCH;
            states[block_index(8, 64, 8)] = STONE;
            load_section(e, 0, 4, 0, states);
            finish(e);
            e.push_event(LightEvent::BlockChange {
                x: 8,
                y: 64,
                z: 8,
                state_id: AIR,
            });
        };

        let mut continuous = engine();
        setup(&mut continuous);
        finish(&mut continuous);
        let want = block_along_x(&continuous, 4, 8);
        assert_eq!(want[5], 9);

        let mut sliced = engine();
        setup(&mut sliced);
        sliced.step_nodes(1);
        finish(&mut sliced);
        assert_eq!(block_along_x(&sliced, 4, 8), want, "sliced must match continuous (opened path)");
    }

    /// Known LIGHT_ONLY 14 arriving first must seed a later Loaded air neighbor.
    #[test]
    fn boundary_arrives_before_loaded_blocks() {
        let mut e = engine();
        let mut packed = pack_uniform_section(0);
        set_nibble(&mut packed, 15, 0, 8, 14);
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 4,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(packed),
        });
        finish(&mut e);
        load_section(&mut e, 1, 4, 0, x_air_tunnel());
        finish(&mut e);
        assert_eq!(
            e.get_block_light(16, 64, 8),
            13,
            "known boundary must seed newly loaded neighbor"
        );
        assert_eq!(e.get_block_light(15, 64, 8), 14, "LIGHT_ONLY stays read-only 14");
    }

    /// Reverse arrival (Loaded first, then LIGHT_ONLY) stays the existing seed path.
    #[test]
    fn loaded_blocks_then_boundary_still_seeds() {
        let mut e = engine();
        load_section(&mut e, 1, 4, 0, x_air_tunnel());
        finish(&mut e);
        let mut packed = pack_uniform_section(0);
        set_nibble(&mut packed, 15, 0, 8, 14);
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 4,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Data(packed),
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(16, 64, 8), 13);
        assert_eq!(e.get_block_light(15, 64, 8), 14);
    }

    /// Unloading a Loaded torch column must decrease the dependent Loaded neighbor.
    #[test]
    fn removing_loaded_source_column() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, x_air_tunnel());
        let mut source = x_air_tunnel();
        source[block_index(16, 64, 8)] = TORCH;
        load_section(&mut e, 1, 4, 0, source);
        finish(&mut e);
        assert_eq!(e.get_block_light(15, 64, 8), 13);
        assert_eq!(e.get_block_light(16, 64, 8), 14);

        e.push_event(LightEvent::UnloadColumn { sx: 1, sz: 0 });
        finish(&mut e);
        assert_eq!(
            e.get_block_light(15, 64, 8),
            0,
            "unloaded source must not persist in the remaining Loaded area"
        );
        assert_eq!(e.section_availability(1, 4, 0), SectionAvailability::Unloaded);
    }

    /// Unloaded support is unknown, not a known-zero wall: reloading the torch restores light.
    #[test]
    fn removing_then_reloading_source_column_restores() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, x_air_tunnel());
        let mut source = x_air_tunnel();
        source[block_index(16, 64, 8)] = TORCH;
        load_section(&mut e, 1, 4, 0, source.clone());
        finish(&mut e);
        e.push_event(LightEvent::UnloadColumn { sx: 1, sz: 0 });
        finish(&mut e);
        assert_eq!(e.get_block_light(15, 64, 8), 0);

        load_section(&mut e, 1, 4, 0, source);
        finish(&mut e);
        assert_eq!(e.get_block_light(16, 64, 8), 14);
        assert_eq!(e.get_block_light(15, 64, 8), 13);
    }

    #[test]
    fn removing_loaded_source_column_sliced_matches_continuous() {
        let setup = |e: &mut LightEngine| {
            load_section(e, 0, 4, 0, x_air_tunnel());
            let mut source = x_air_tunnel();
            source[block_index(16, 64, 8)] = TORCH;
            load_section(e, 1, 4, 0, source);
            finish(e);
            e.push_event(LightEvent::UnloadColumn { sx: 1, sz: 0 });
        };

        let mut continuous = engine();
        setup(&mut continuous);
        finish(&mut continuous);
        assert_eq!(continuous.get_block_light(15, 64, 8), 0);

        let mut sliced = engine();
        setup(&mut sliced);
        sliced.step_nodes(2);
        finish(&mut sliced);
        assert_eq!(
            sliced.get_block_light(15, 64, 8),
            continuous.get_block_light(15, 64, 8),
            "sliced must match continuous (unload source column)"
        );
    }

    /// Re-ingest that opens a path (stone → air) must pull from the already-lit Loaded neighbor.
    #[test]
    fn ingest_replacing_blocker_opens_block_path() {
        let mut e = engine();
        let mut west = x_air_tunnel();
        west[block_index(15, 64, 8)] = TORCH;
        load_section(&mut e, 0, 4, 0, west);
        let mut east = x_air_tunnel();
        east[block_index(16, 64, 8)] = STONE;
        load_section(&mut e, 1, 4, 0, east);
        finish(&mut e);
        assert_eq!(e.get_block_light(15, 64, 8), 14);
        assert_eq!(e.get_block_light(16, 64, 8), 0);
        assert_eq!(e.get_block_light(17, 64, 8), 0);

        load_section(&mut e, 1, 4, 0, x_air_tunnel());
        finish(&mut e);
        assert_eq!(e.get_block_light(16, 64, 8), 13, "ingest must wake the opened contact");
        assert_eq!(e.get_block_light(17, 64, 8), 12);
    }

    /// Sky analog: unloading a LIGHT_ONLY sky support must darken the dependent Loaded air.
    #[test]
    fn removing_sky_boundary_column_clears_dependent() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, x_air_tunnel());
        set_sky_only_boundary(&mut e, 1, 4, 0, 15);
        finish(&mut e);
        assert_eq!(e.get_sky_light(16, 64, 8), 15, "LIGHT_ONLY sky stays 15");
        assert_eq!(e.get_sky_light(15, 64, 8), 14);

        e.push_event(LightEvent::UnloadColumn { sx: 1, sz: 0 });
        finish(&mut e);
        assert_eq!(
            e.get_sky_light(15, 64, 8),
            0,
            "unloaded sky boundary must not leave residual sky"
        );
    }

    /// Seed in the same batch as torch removal still erases the far section (Phase 1).
    #[test]
    fn seed_erases_cross_section_decrease() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, x_air_tunnel());
        load_section(&mut e, 1, 4, 0, x_air_tunnel());
        e.push_event(LightEvent::BlockChange {
            x: 15,
            y: 64,
            z: 8,
            state_id: TORCH,
        });
        finish(&mut e);
        e.push_event(LightEvent::BlockChange {
            x: 15,
            y: 64,
            z: 8,
            state_id: AIR,
        });
        e.push_event(LightEvent::ServerLight {
            sx: 0,
            sy: 4,
            sz: 0,
            channel: LightChannel::Block,
            kind: ServerLightKind::Empty,
        });
        finish(&mut e);
        assert_eq!(e.get_block_light(15, 64, 8), 0);
        assert_eq!(e.get_block_light(16, 64, 8), 0);
    }

    /// Two loaded columns must not form one view-distance-sized transaction.
    #[test]
    fn batch_admits_one_column_not_entire_pending_queue() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        for sy in 0..16 {
            load_section(&mut e, 1, sy, 0, air_section());
        }
        let first = drain_until_publication(&mut e).expect("first column must publish before later pending columns");
        assert!(
            first.sections.iter().all(|section| section.sx == 0 && section.sz == 0),
            "first publication must stay inside the admitted column"
        );
        assert!(
            e.step(0.0),
            "second column must remain queued after the first publication"
        );
        let second = finish(&mut e).expect("second column publishes after the first unit");
        assert!(
            second.sections.iter().all(|section| section.sx == 1 && section.sz == 0),
            "second publication must be the next FIFO column"
        );
        assert_eq!(e.get_sky_light(8, 64, 8), 15);
        assert_eq!(e.get_sky_light(24, 64, 8), 15);
    }

    /// Load/availability/seed of one column stay one unit so sources are not reconciled 16 times.
    #[test]
    fn batch_keeps_same_column_events_together() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        let first = drain_until_publication(&mut e).expect("column load must publish");
        assert!(!e.step(0.0), "a single column is one admission unit");
        assert_eq!(first.sections.len(), 16);
        assert!(first.sections.iter().all(|section| section.sx == 0 && section.sz == 0));
    }

    /// FIFO inside the unit: a later edit cannot enter an earlier foreign-column batch.
    /// After that unit publishes, the leftover edit jumps remaining bulk.
    #[test]
    fn batch_fifo_keeps_later_edit_after_prior_columns() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        for sy in 0..16 {
            load_section(&mut e, 1, sy, 0, air_section());
        }
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: STONE,
        });
        let first = drain_until_publication(&mut e).unwrap();
        assert!(first.sections.iter().all(|section| section.sx == 0));
        assert_eq!(e.get_sky_light(8, 64, 8), 15, "edit must not apply inside column 0 batch");
        let second = drain_until_publication(&mut e).unwrap();
        assert!(
            second.sections.iter().all(|section| section.sx == 0),
            "leftover edit of the already-loaded column jumps remaining bulk"
        );
        assert!(e.get_sky_light(8, 64, 8) < 15, "edit applies once its leftover unit is admitted");
        let third = drain_until_publication(&mut e).unwrap();
        assert!(third.sections.iter().all(|section| section.sx == 1));
    }

    /// A later edit of a different column jumps the whole column unit ahead of the convoy.
    #[test]
    fn batch_edit_jumps_foreign_column_convoy() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        for sy in 0..16 {
            load_section(&mut e, 1, sy, 0, air_section());
        }
        e.push_event(LightEvent::BlockChange {
            x: 24,
            y: 64,
            z: 8,
            state_id: STONE,
        });
        let first = drain_until_publication(&mut e).unwrap();
        assert!(
            first.sections.iter().all(|section| section.sx == 1 && section.sz == 0),
            "edit column unit must be admitted first"
        );
        assert!(e.get_sky_light(24, 64, 8) < 15, "jumped edit applies in its own unit");
        let second = drain_until_publication(&mut e).unwrap();
        assert!(second.sections.iter().all(|section| section.sx == 0 && section.sz == 0));
    }

    /// Interactive edits must not disappear beyond a bounded bulk scan window.
    #[test]
    fn batch_edit_jumps_long_convoy() {
        for already_loaded in [false, true] {
            let mut e = engine();
            e.set_sky_light_enabled(false);
            load_section(&mut e, -1, 4, 0, air_section());
            if already_loaded {
                finish(&mut e);
            }
            // Cheap bulk events isolate admission from solver cost. More than
            // 1024 events, with the edited column initially at the FIFO head.
            for sx in 1..4097 {
                e.push_event(LightEvent::SetAvailability {
                    sx,
                    sy: 4,
                    sz: 0,
                    availability: SectionAvailability::Loaded,
                });
            }
            e.push_event(LightEvent::BlockChange {
                x: -8,
                y: 64,
                z: 8,
                state_id: TORCH,
            });
            // If ingest is at the head it is still its own transaction. The
            // edit must be admitted at the very next boundary, not after bulk.
            if !already_loaded {
                e.step_nodes(usize::MAX);
                e.poll_completed_publication();
                assert_eq!(e.get_block_light(-8, 64, 8), 0);
            }
            e.step_nodes(usize::MAX);
            assert_eq!(e.get_block_light(-8, 64, 8), 14,
                "edit must jump long convoy (already_loaded={already_loaded})");
            assert!(e.poll_completed_publication().is_some());
            assert_eq!(e.pending.len(), 4096);
            for (index, event) in e.pending.iter().enumerate() {
                assert_eq!(event_column(event), (index as i32 + 1, 0));
            }
        }
    }

    /// Startup bulk must not delay the other side of an edited X/Z boundary.
    #[test]
    fn batch_edit_promotes_pending_light_neighbors() {
        for edit_at_head in [false, true] {
            for (x, z, neighbors, target) in [
                (15, 8, vec![(1, 0)], (16, 8)),
                (8, 15, vec![(0, 1)], (8, 16)),
                (0, 0, vec![(-1, 0), (0, -1), (-1, -1)], (-1, -1)),
            ] {
                let mut e = engine();
                e.set_sky_light_enabled(false);
                load_section(&mut e, 0, 4, 0, air_section());
                finish(&mut e);
                let edit = LightEvent::BlockChange { x, y: 72, z, state_id: TORCH };
                if edit_at_head { e.push_event(edit.clone()); }
                for sx in 100..164 {
                    load_section(&mut e, sx, 4, 0, air_section());
                }
                for &(sx, sz) in &neighbors {
                    load_section(&mut e, sx, 4, sz, air_section());
                }
                if !edit_at_head { e.push_event(edit); }
                // One transaction for the edit and one per pending neighbor.
                for _ in 0..=neighbors.len() {
                    e.step_nodes(usize::MAX);
                    e.poll_completed_publication();
                }
                let distance = (target.0 - x).abs() + (target.1 - z).abs();
                assert_eq!(e.get_block_light(target.0, 72, target.1), 14 - distance as u8,
                    "neighbor must light before bulk: head={edit_at_head}, x={x}, z={z}");
                assert_eq!(e.section_availability(100, 4, 0), SectionAvailability::Unloaded);
                assert_eq!(e.pending.len(), 128, "unrelated bulk remains queued");
                let early = e.get_block_light(target.0, 72, target.1);
                finish(&mut e);
                assert_eq!(e.get_block_light(target.0, 72, target.1), early);
            }
        }
    }

    #[test]
    fn batch_neighbor_promotion_preserves_lifecycle_and_bulk_order() {
        let edit = LightEvent::BlockChange { x: 15, y: 72, z: 8, state_id: TORCH };
        let neighbor = vec![
            LightEvent::UnloadColumn { sx: 1, sz: 0 },
            LightEvent::IngestBlockSection { sx: 1, sy: 4, sz: 0, states: air_section() },
            LightEvent::SetAvailability { sx: 1, sy: 4, sz: 0, availability: SectionAvailability::Loaded },
            LightEvent::ServerLight { sx: 1, sy: 4, sz: 0, channel: LightChannel::Block, kind: ServerLightKind::Empty },
        ];
        let bulk: Vec<_> = (100..104).map(|sx| LightEvent::UnloadColumn { sx, sz: 0 }).collect();
        let mut pending = VecDeque::new();
        for (a, b) in bulk.iter().zip(&neighbor) {
            pending.push_back(a.clone());
            pending.push_back(b.clone());
        }
        pending.push_back(edit.clone());
        promote_edit_column(&mut pending, |sx, sz| (sx, sz) == (0, 0));
        let expected: VecDeque<_> = std::iter::once(edit)
            .chain(neighbor).chain(bulk).collect();
        assert_eq!(format!("{pending:?}"), format!("{expected:?}"));
    }

    /// Bulk columns keep their relative order around a jumped edit unit.
    #[test]
    fn batch_edit_jump_preserves_remaining_bulk_order() {
        let mut e = engine();
        for sx in 0..3 {
            for sy in 0..16 {
                load_section(&mut e, sx, sy, 0, air_section());
            }
        }
        e.push_event(LightEvent::BlockChange {
            x: 24,
            y: 64,
            z: 8,
            state_id: STONE,
        });
        let first = drain_until_publication(&mut e).unwrap();
        assert!(first.sections.iter().all(|section| section.sx == 1));
        let second = drain_until_publication(&mut e).unwrap();
        assert!(second.sections.iter().all(|section| section.sx == 0));
        let third = drain_until_publication(&mut e).unwrap();
        assert!(third.sections.iter().all(|section| section.sx == 2));
    }

    /// A naked BlockChange for an unknown column must not jump or become AIR.
    #[test]
    fn batch_edit_does_not_jump_unknown_column() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        e.push_event(LightEvent::BlockChange {
            x: 80,
            y: 64,
            z: 8,
            state_id: STONE,
        });
        let first = drain_until_publication(&mut e).unwrap();
        assert!(first.sections.iter().all(|section| section.sx == 0 && section.sz == 0));
        assert!(
            finish(&mut e).is_none(),
            "unknown edit must not publish a phantom AIR column"
        );
        assert!(
            e.packed_block_light(5, 4, 0).is_none(),
            "unknown column must stay unknown, not a Loaded AIR fill"
        );
        assert!(!e.step(0.0));
    }

    /// Column (sx,sz) known via another sy still leaves a missing sy unknown.
    /// AIR-filling that sy would materialize unknown as Loaded air.
    #[test]
    fn batch_edit_known_column_missing_sy_does_not_materialize_air() {
        let mut e = engine();
        load_section(&mut e, 0, 4, 0, air_section());
        finish(&mut e);
        assert!(e.packed_block_light(0, 4, 0).is_some());
        assert_eq!(e.section_availability(0, 5, 0), SectionAvailability::Unloaded);

        for sy in 0..16 {
            load_section(&mut e, 1, sy, 0, air_section());
        }
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 80,
            z: 8,
            state_id: STONE,
        });

        let mut saw_publication = false;
        while let Some(publication) = drain_until_publication(&mut e) {
            saw_publication = true;
            assert!(
                publication
                    .sections
                    .iter()
                    .all(|section| !(section.sx == 0 && section.sy == 5 && section.sz == 0)),
                "must not publish a phantom AIR section at the missing sy"
            );
        }
        assert!(saw_publication, "bulk column must still publish");
        assert!(
            e.packed_block_light(0, 5, 0).is_none(),
            "missing sy must stay unknown, not a Loaded AIR fill"
        );
        assert_eq!(e.section_availability(0, 5, 0), SectionAvailability::Unloaded);
        assert!(e.packed_block_light(0, 4, 0).is_some(), "known sy stays present");
        assert!(!e.step(0.0));
    }

    /// An edit of an already-loaded column jumps ahead of later bulk ingest.
    #[test]
    fn batch_edit_jumps_loaded_column_ahead_of_new_bulk() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 64, 8), 15);
        for sy in 0..16 {
            load_section(&mut e, 1, sy, 0, air_section());
        }
        for sy in 0..16 {
            load_section(&mut e, 2, sy, 0, air_section());
        }
        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 64,
            z: 8,
            state_id: STONE,
        });
        let first = drain_until_publication(&mut e).unwrap();
        assert!(
            first.sections.iter().all(|section| section.sx == 0 && section.sz == 0),
            "loaded edit column must jump ahead of new bulk"
        );
        assert!(e.get_sky_light(8, 64, 8) < 15);
        let second = drain_until_publication(&mut e).unwrap();
        assert!(second.sections.iter().all(|section| section.sx == 1 && section.sz == 0));
        let third = drain_until_publication(&mut e).unwrap();
        assert!(third.sections.iter().all(|section| section.sx == 2 && section.sz == 0));
    }

    /// BFS must reuse derived (x,z) source-meta. One air column is 256 sticks × H=256.
    #[test]
    fn sky_source_scan_is_memoized_across_bfs() {
        let mut e = LightEngine::new(0, 256);
        let (emission, light_block) = default_test_tables();
        e.set_light_tables(&emission, &light_block);
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 64, 8), 15);
        let rows = e.sky_source_scan_rows.get();
        assert!(
            rows <= 256 * 256,
            "source scan must be O(C×H), not O(P×H); rows={rows}"
        );
    }

    /// Changing a blocking cell must drop stale source-meta; sky below the roof darkens.
    #[test]
    fn sky_source_memo_invalidates_on_occluding_block() {
        let mut e = engine();
        for sy in 0..16 {
            load_section(&mut e, 0, sy, 0, air_section());
        }
        finish(&mut e);
        assert_eq!(e.get_sky_light(8, 64, 8), 15);
        let rows_before = e.sky_source_scan_rows.get();

        e.push_event(LightEvent::BlockChange {
            x: 8,
            y: 100,
            z: 8,
            state_id: STONE,
        });
        finish(&mut e);
        assert!(
            e.get_sky_light(8, 64, 8) < 15,
            "occluding block must cut the sky source"
        );
        assert!(
            e.sky_source_scan_rows.get() > rows_before,
            "block/shape change must invalidate derived source-meta"
        );
    }

    /// Availability + unload are source-scan dependencies; sliced must match continuous.
    #[test]
    fn sky_source_memo_invalidates_on_availability_unload_sliced() {
        let setup = |e: &mut LightEngine| {
            load_section(e, 0, 4, 0, x_air_tunnel());
            e.push_event(LightEvent::SetAvailability {
                sx: 1,
                sy: 4,
                sz: 0,
                availability: SectionAvailability::LightOnly,
            });
            e.push_event(LightEvent::ServerLight {
                sx: 1,
                sy: 4,
                sz: 0,
                channel: LightChannel::Sky,
                kind: ServerLightKind::Data(pack_uniform_section(15)),
            });
            finish(e);
            e.push_event(LightEvent::UnloadColumn { sx: 1, sz: 0 });
        };

        let mut continuous = engine();
        setup(&mut continuous);
        finish(&mut continuous);
        let want = continuous.get_sky_light(15, 64, 8);

        let mut sliced = engine();
        setup(&mut sliced);
        sliced.step_nodes(2);
        finish(&mut sliced);
        assert_eq!(
            sliced.get_sky_light(15, 64, 8),
            want,
            "sliced must match continuous after sky-boundary unload"
        );
    }
}
