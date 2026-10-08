// One editor (and so one undo history) per map, shared by every view of it:
// two views of the same map edit the same store, so they must undo the same
// history.

import type { MapStore } from '../storage/map_store';
import { MapEditor } from './editor';

const editors = new WeakMap<MapStore, MapEditor>();

export function editorFor(store: MapStore): MapEditor {
	let e = editors.get(store);
	if (!e) editors.set(store, (e = new MapEditor(store)));
	return e;
}
