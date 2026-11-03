"""Helpers for story scene scripts. Runs inside Blender (blender -b), 4.2 LTS or newer.

A story's scenes.py gets a `Ctx` and builds everything with these helpers. All timing
comes from the timeline through the Ctx (ctx.shot, ctx.cue, ctx.beat), never from
hard-coded frame numbers, so a re-voiced story re-times itself on the next build.

Conventions
  - Frames are 0-based; the timeline's total_frames is one past the last rendered frame.
    For a seamless loop, anything periodic must have the same state at frame 0 and
    frame total_frames (see loop_spin and orbit_keys).
  - Each "set" lives in its own collection, placed far from the others, and is only
    visible during the shots that use it (ctx.set_collection). Lights included, so a
    sun lamp in one set does not light another.
  - Keyframes use key(); it sets interpolation without touching F-curves, which keeps
    it working across Blender's 4.4+ layered-action changes.
"""
import math

import bpy

# ------------------------------------------------------------------ scene setup


def engine_id(name):
    items = bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys()
    name = (name or "EEVEE").upper()
    if name == "CYCLES":
        return "CYCLES"
    if name == "WORKBENCH":
        return "BLENDER_WORKBENCH"
    for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if cand in items:
            return cand
    return "BLENDER_EEVEE"


def _try(obj, attr, value):
    try:
        setattr(obj, attr, value)
        return True
    except (AttributeError, TypeError, ValueError):
        return False


def setup_scene(tl, render):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    r = sc.render
    r.engine = engine_id(render.get("engine"))
    r.resolution_x, r.resolution_y = tl["width"], tl["height"]
    r.resolution_percentage = 100
    r.fps, r.fps_base = tl["fps"], 1.0
    sc.frame_start, sc.frame_end = 0, tl["total_frames"] - 1
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    # Resumable final renders: skip frames that exist, claim a frame with a placeholder.
    r.use_overwrite = False
    r.use_placeholder = True
    r.use_motion_blur = bool(render.get("motion_blur", False))

    vs = sc.view_settings
    _try(vs, "view_transform", "AgX") or _try(vs, "view_transform", "Filmic")
    _try(vs, "look", render.get("look", "AgX - Medium High Contrast"))

    samples = int(render.get("samples", 32))
    if r.engine == "CYCLES":
        sc.cycles.samples = samples
        _try(sc.cycles, "use_denoising", True)
    elif r.engine.startswith("BLENDER_EEVEE"):
        sc.eevee.taa_render_samples = samples
        _try(sc.eevee, "use_bloom", True)          # legacy EEVEE only
        _try(sc.eevee, "use_gtao", True)
        _try(sc.eevee, "use_shadows", True)

    world = bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (*render.get("world_color", (0.004, 0.005, 0.009)), 1)
        bg.inputs[1].default_value = 1.0
    if render.get("glow", True):
        add_glow(sc, render.get("glow_threshold", 0.9), render.get("glow_mix", -0.55))
    return sc


def add_glow(sc, threshold=0.9, mix=-0.55):
    """Fog-glow in the compositor (EEVEE 4.2+ has no built-in bloom). Best effort."""
    try:
        if hasattr(sc, "compositing_node_group"):            # Blender 5.0+
            tree = bpy.data.node_groups.new("Compositing", "CompositorNodeTree")
            sc.compositing_node_group = tree
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            src = tree.nodes.new("CompositorNodeRLayers")
            dst = tree.nodes.new("NodeGroupOutput")
        else:
            sc.use_nodes = True
            tree = sc.node_tree
            src = tree.nodes.get("Render Layers") or tree.nodes.new("CompositorNodeRLayers")
            dst = tree.nodes.get("Composite") or tree.nodes.new("CompositorNodeComposite")
        glare = tree.nodes.new("CompositorNodeGlare")
        for attr, val in (("glare_type", "FOG_GLOW"), ("quality", "HIGH"),
                          ("threshold", threshold), ("mix", mix), ("size", 8)):
            if not _try(glare, attr, val):
                for sock in glare.inputs:                    # 4.4+/5.0 moved these to inputs
                    if sock.name.lower() == attr.replace("glare_", "").lower():
                        _try(sock, "default_value", val.title().replace("_", " ")
                             if isinstance(val, str) else val)
        tree.links.new(src.outputs[0], glare.inputs[0])
        tree.links.new(glare.outputs[0], dst.inputs[0])
    except Exception as e:  # noqa: BLE001 - glow is cosmetic; never fail the build for it
        print(f"[lib] compositor glow skipped: {e}")


# ------------------------------------------------------------------ materials


def _sock(node, *names):
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    return node.inputs[names[0]]


def material(name, color=(0.8, 0.8, 0.8), rough=0.5, metal=0.0, emit=None, strength=0.0):
    """Principled material. Returns it; emission strength socket via emit_socket(mat)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    _sock(b, "Base Color").default_value = (*color, 1)
    _sock(b, "Roughness").default_value = rough
    _sock(b, "Metallic").default_value = metal
    if emit is not None:
        _sock(b, "Emission Color", "Emission").default_value = (*emit, 1)
        _sock(b, "Emission Strength").default_value = strength
    return m


def glow(name, color, strength=5.0):
    """Pure emission material (cheap, ideal for screens, lines and lights you can see)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em.inputs["Color"].default_value = (*color, 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def emit_socket(m):
    """The emission strength socket of a material made by material() or glow()."""
    nodes = m.node_tree.nodes
    if nodes.get("Emission"):
        return nodes["Emission"].inputs["Strength"]
    return _sock(nodes["Principled BSDF"], "Emission Strength")


def emit_color_socket(m):
    nodes = m.node_tree.nodes
    if nodes.get("Emission"):
        return nodes["Emission"].inputs["Color"]
    return _sock(nodes["Principled BSDF"], "Emission Color", "Emission")


def blended(m):
    """Mark a material as alpha-blended (for glows/atmospheres built with Transparent)."""
    _try(m, "surface_render_method", "BLENDED")   # EEVEE 4.2+
    _try(m, "blend_method", "BLEND")              # legacy EEVEE
    return m


# ------------------------------------------------------------------ objects

_PRIMS = {
    "cube": "primitive_cube_add", "sphere": "primitive_uv_sphere_add",
    "ico": "primitive_ico_sphere_add", "cyl": "primitive_cylinder_add",
    "cone": "primitive_cone_add", "plane": "primitive_plane_add",
    "torus": "primitive_torus_add", "grid": "primitive_grid_add",
}


def move_to(obj, coll):
    if coll is None:
        return obj
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    return obj


def add(kind, name, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), mat=None,
        smooth=False, coll=None, parent=None, **kw):
    """Add a mesh primitive. kind: cube sphere ico cyl cone plane torus grid."""
    getattr(bpy.ops.mesh, _PRIMS[kind])(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    if mat is not None:
        o.data.materials.append(mat)
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    if parent is not None:
        o.parent = parent
    return move_to(o, coll)


def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), coll=None, parent=None):
    o = bpy.data.objects.new(name, None)
    (coll or bpy.context.scene.collection).objects.link(o)
    o.location, o.rotation_euler = loc, rot
    if parent is not None:
        o.parent = parent
    return o


def text(name, body, loc=(0, 0, 0), size=1.0, mat=None, rot=(math.pi / 2, 0, 0),
         align="CENTER", extrude=0.0, coll=None, parent=None, font=None):
    """Text facing -Y by default (toward a camera that looks along +Y)."""
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.extrude = extrude
    if font:
        cu.font = bpy.data.fonts.load(font)
    o = bpy.data.objects.new(name, cu)
    (coll or bpy.context.scene.collection).objects.link(o)
    o.location, o.rotation_euler = loc, rot
    if mat is not None:
        o.data.materials.append(mat)
    if parent is not None:
        o.parent = parent
    return o


def camera(name, loc, target, lens=35.0, coll=None, dof_fstop=None):
    """Camera that always looks at an empty. Animate either one. Returns (cam, target)."""
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_start, cd.clip_end = 0.05, 5000
    cam = bpy.data.objects.new(name, cd)
    tgt = empty(name + "_target", target, coll=coll)
    (coll or bpy.context.scene.collection).objects.link(cam)
    cam.location = loc
    c = cam.constraints.new("TRACK_TO")
    c.target = tgt
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"
    if dof_fstop:
        cd.dof.use_dof = True
        cd.dof.focus_object = tgt
        cd.dof.aperture_fstop = dof_fstop
    return cam, tgt


def light(name, kind, loc, energy, color=(1, 1, 1), size=0.5, target=None, coll=None,
          spot_deg=60.0):
    """kind: POINT SUN SPOT AREA. target: a location or object to aim at (SUN/SPOT/AREA)."""
    ld = bpy.data.lights.new(name, kind.upper())
    ld.energy = energy
    ld.color = color
    if kind.upper() == "AREA":
        ld.size = size
    elif kind.upper() == "SUN":
        ld.angle = math.radians(size)
    else:
        ld.shadow_soft_size = size
    if kind.upper() == "SPOT":
        ld.spot_size = math.radians(spot_deg)
        ld.spot_blend = 0.4
    o = bpy.data.objects.new(name, ld)
    (coll or bpy.context.scene.collection).objects.link(o)
    o.location = loc
    if target is not None:
        tgt = target if hasattr(target, "location") else empty(name + "_aim", target, coll=coll)
        c = o.constraints.new("TRACK_TO")
        c.target = tgt
        c.track_axis = "TRACK_NEGATIVE_Z"
        c.up_axis = "UP_Y"
    return o


def aim_rotation(a, b):
    """Euler that turns a +Z-pointing object to point from a toward b. Returns (rot, length)."""
    d = [b[i] - a[i] for i in range(3)]
    length = math.sqrt(sum(x * x for x in d)) or 1e-9
    return (0.0, math.acos(max(-1.0, min(1.0, d[2] / length))), math.atan2(d[1], d[0])), length


def beam(name, a, b, mat, radius=0.03, coll=None, parent=None):
    """A thin cylinder from a to b, built to grow: animate grow(beam, frame, fraction).
    Returns the pivot empty at a; the cylinder is its child."""
    rot, length = aim_rotation(a, b)
    pivot = empty(name + "_pivot", a, rot, coll=coll, parent=parent)
    cyl = add("cyl", name, (0, 0, length / 2), mat=mat, coll=coll, parent=pivot,
              radius=radius, depth=1.0, vertices=16)
    cyl.scale = (1, 1, length)
    cyl["beam_length"] = length
    return pivot


def grow(pivot, frame, fraction, interp="BEZIER"):
    cyl = pivot.children[0]
    length = cyl["beam_length"]
    f = max(fraction, 1e-4)
    key(cyl, "scale", frame, (1, 1, length * f), interp)
    key(cyl, "location", frame, (0, 0, length * f / 2), interp)


# ------------------------------------------------------------------ animation


def key(owner, path, frame, value=None, interp="BEZIER", index=-1):
    """Set owner.<path> (optionally one index of it) and keyframe it at frame."""
    if value is not None:
        if index >= 0:
            getattr(owner, path)[index] = value
        else:
            setattr(owner, path, value)
    prefs = bpy.context.preferences.edit
    old = prefs.keyframe_new_interpolation_type
    prefs.keyframe_new_interpolation_type = interp
    try:
        owner.keyframe_insert(data_path=path, frame=frame, index=index)
    finally:
        prefs.keyframe_new_interpolation_type = old


def visible(objs, ranges):
    """Show objs only inside the inclusive [start, end] frame ranges (constant keys)."""
    ranges = sorted(ranges)
    for o in objs:
        key(o, "hide_render", 0, not any(a <= 0 <= b for a, b in ranges), "CONSTANT")
        key(o, "hide_viewport", 0, not any(a <= 0 <= b for a, b in ranges), "CONSTANT")
        for a, b in ranges:
            if a > 0:
                key(o, "hide_render", a, False, "CONSTANT")
                key(o, "hide_viewport", a, False, "CONSTANT")
            key(o, "hide_render", b + 1, True, "CONSTANT")
            key(o, "hide_viewport", b + 1, True, "CONSTANT")


def loop_spin(obj, total, turns=1, axis=2, phase=0.0):
    """Spin with the same pose at frame 0 and frame total (whole turns only)."""
    if turns != int(turns):
        raise ValueError("loop_spin needs whole turns for a seamless loop")
    key(obj, "rotation_euler", 0, phase, "LINEAR", axis)
    key(obj, "rotation_euler", total, phase + 2 * math.pi * turns, "LINEAR", axis)


def orbit_keys(obj, total, a, b, theta0=0.0, turns=1, samples=96):
    """Move obj around an ellipse in its parent's XY plane; same spot at 0 and total."""
    for i in range(samples + 1):
        f = round(total * i / samples)
        th = theta0 + 2 * math.pi * turns * i / samples
        key(obj, "location", f, (a * math.cos(th), b * math.sin(th), 0.0), "LINEAR")


def pulse(owner, path, start, end, period, lo, hi, index=-1):
    """Alternate between lo and hi every half period from start to end, then rest at lo."""
    half = max(period // 2, 1)
    f, high = start, True
    while f < end:
        key(owner, path, f, hi if high else lo, "BEZIER", index)
        f += half
        high = not high
    key(owner, path, end, lo, "BEZIER", index)


def fade(owner, path, start, end, a, b, interp="BEZIER", index=-1):
    key(owner, path, start, a, interp, index)
    key(owner, path, end, b, interp, index)


# ------------------------------------------------------------------ context


class Ctx:
    """What a story's build(ctx) gets: the timeline, the story, and shot bookkeeping."""

    def __init__(self, tl, story):
        self.tl, self.story = tl, story
        self.fps = tl["fps"]
        self.total = tl["total_frames"]
        self.scene = bpy.context.scene
        self.shots = {s["id"]: s for s in tl["shots"]}
        self.beats = {b["id"]: b for b in tl["beats"]}
        self.cues = tl.get("cues", {})
        self._cams, self._sets = {}, []

    def shot(self, sid):
        if sid not in self.shots:
            raise KeyError(f"shot {sid!r} is not in the timeline; shots: {list(self.shots)}")
        return self.shots[sid]

    def start(self, sid):
        return self.shot(sid)["start_frame"]

    def end(self, sid):
        return self.shot(sid)["end_frame"]

    def cue(self, name):
        if name not in self.cues:
            raise KeyError(f"cue {name!r} is not in the timeline; cues: {list(self.cues)}")
        return self.cues[name]

    def beat(self, bid):
        return self.beats[bid]

    def sec(self, seconds):
        return int(round(seconds * self.fps))

    def set_collection(self, name, *shot_ids):
        """A collection whose objects render only during the given shots."""
        coll = bpy.data.collections.new(name)
        self.scene.collection.children.link(coll)
        self._sets.append((coll, [(self.start(s), self.end(s)) for s in shot_ids]))
        return coll

    def bind_camera(self, sid, cam):
        self.shot(sid)
        self._cams[sid] = cam

    def finalize(self):
        missing = [s for s in self.shots if s not in self._cams]
        if missing:
            raise RuntimeError(f"no camera bound for shots: {missing} (use ctx.bind_camera)")
        for coll, ranges in self._sets:
            visible(list(coll.all_objects), ranges)
        for s in self.tl["shots"]:
            m = self.scene.timeline_markers.new(s["id"], frame=s["start_frame"])
            m.camera = self._cams[s["id"]]
        self.scene.camera = self._cams[self.tl["shots"][0]["id"]]
        self.scene.frame_set(0)


def camera_at(scene, frame):
    """The camera the shot markers make active at a frame."""
    best = None
    for m in scene.timeline_markers:
        if m.camera is not None and m.frame <= frame and (best is None or m.frame > best.frame):
            best = m
    return best.camera if best else scene.camera
