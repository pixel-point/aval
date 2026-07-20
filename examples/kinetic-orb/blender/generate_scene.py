"""Generate and render the deterministic kinetic-orb calibration scene."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


SCRIPT_DIR = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from timeline import (  # noqa: E402
    FRAME_END,
    FRAME_START,
    FPS,
    HOVER_ENERGY,
    IDLE_ENERGY,
    pose_for_frame,
    validate_timeline,
)


SIZE = 512
EXAMPLE_DIR = SCRIPT_DIR.parent
BLEND_PATH = EXAMPLE_DIR / "kinetic-orb.blend"
FRAMES_DIR = EXAMPLE_DIR / "source" / "frames"
SEAM_COUNT = 12
SEAM_SPACING_DEGREES = 15.0


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--smoke-frame", type=int)
    return parser.parse_args(args)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.meshes,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def principled_material(
    name: str,
    base_color: tuple[float, float, float, float],
    *,
    metallic: float = 0.0,
    roughness: float = 0.4,
    emission_color: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = base_color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emission_color is not None:
        shader.inputs["Emission Color"].default_value = emission_color
        shader.inputs["Emission Strength"].default_value = emission_strength
    return material


def add_uv_sphere(
    name: str,
    radius: float,
    material: bpy.types.Material,
    *,
    segments: int = 96,
    rings: int = 64,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        radius=radius,
        location=(0.0, 0.0, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_curve_loop(
    name: str,
    points: list[tuple[float, float, float]],
    bevel: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name, type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = bevel
    curve.bevel_resolution = 3
    spline = curve.splines.new("NURBS")
    spline.points.add(len(points) - 1)
    for point, coordinate in zip(spline.points, points, strict=True):
        point.co = (*coordinate, 1.0)
    spline.use_cyclic_u = True
    spline.order_u = min(3, len(points))
    spline.use_endpoint_u = False
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def great_circle_points(
    radius: float,
    phase: float,
    samples: int = 192,
) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    rotation = Matrix.Rotation(phase, 4, "Z")
    for index in range(samples):
        angle = math.tau * index / samples
        local = Vector((radius * math.sin(angle), 0.0, radius * math.cos(angle)))
        local.rotate(rotation)
        points.append(tuple(local))
    return points


def add_area_light(
    name: str,
    location: tuple[float, float, float],
    energy: float,
    color: tuple[float, float, float],
    size: float,
) -> None:
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    point_at(obj, (0.0, 0.0, 0.0))


def point_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def shader(material: bpy.types.Material) -> bpy.types.Node:
    return material.node_tree.nodes["Principled BSDF"]


def mix(start: float, end: float, amount: float) -> float:
    return start + (end - start) * amount


def mix_color(
    start: tuple[float, float, float, float],
    end: tuple[float, float, float, float],
    amount: float,
) -> tuple[float, float, float, float]:
    return tuple(mix(left, right, amount) for left, right in zip(start, end, strict=True))


def energy_ramp(
    energy: float,
    off: float | tuple[float, float, float, float],
    idle: float | tuple[float, float, float, float],
    hover: float | tuple[float, float, float, float],
) -> float | tuple[float, float, float, float]:
    if energy <= IDLE_ENERGY:
        amount = max(0.0, energy / IDLE_ENERGY)
        start, end = off, idle
    else:
        amount = min(1.0, (energy - IDLE_ENERGY) / (HOVER_ENERGY - IDLE_ENERGY))
        start, end = idle, hover

    if isinstance(start, tuple) and isinstance(end, tuple):
        return mix_color(start, end, amount)
    if isinstance(start, float) and isinstance(end, float):
        return mix(start, end, amount)
    raise TypeError("energy ramp values must have matching types")


def setup_scene() -> dict[str, object]:
    clear_scene()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.render.fps = FPS
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
    scene.render.use_file_extension = True
    scene.render.filepath = str(FRAMES_DIR / "frame-")
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.20
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.1

    world = bpy.data.worlds.get("Calibration World") or bpy.data.worlds.new("Calibration World")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.001, 0.002, 0.004, 1.0)
    background.inputs["Strength"].default_value = 0.08
    scene.world = world

    shell_material = principled_material(
        "Graphite Ball",
        (0.002, 0.004, 0.006, 1.0),
        metallic=0.18,
        roughness=0.52,
        emission_color=(0.0, 0.32, 0.55, 1.0),
        emission_strength=0.0,
    )
    seam_material = principled_material(
        "Calibration Seams",
        (0.001, 0.003, 0.005, 1.0),
        metallic=0.05,
        roughness=0.32,
        emission_color=(0.0, 0.68, 1.0, 1.0),
        emission_strength=0.0,
    )
    floor_material = principled_material(
        "Ground",
        (0.003, 0.005, 0.009, 1.0),
        metallic=0.02,
        roughness=0.62,
    )

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    tilt_root = bpy.context.object
    tilt_root.name = "Calibration Ball Tilt"
    tilt_root.rotation_mode = "XYZ"
    tilt_root.rotation_euler.x = math.radians(-18.0)
    tilt_root.rotation_euler.y = math.radians(22.0)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    root = bpy.context.object
    root.name = "Calibration Ball Spin"
    root.rotation_mode = "XYZ"
    root.parent = tilt_root

    shell = add_uv_sphere("Calibration Ball", 1.15, shell_material)
    shell.parent = root

    for index in range(SEAM_COUNT):
        seam = add_curve_loop(
            f"Meridian Seam {index + 1:02d}",
            great_circle_points(1.171, math.radians(index * SEAM_SPACING_DEGREES)),
            0.019,
            seam_material,
        )
        seam.parent = root

    bpy.ops.mesh.primitive_plane_add(size=24.0, location=(0.0, 0.0, -1.34))
    floor = bpy.context.object
    floor.name = "Ground Plane"
    floor.data.materials.append(floor_material)

    bpy.ops.object.camera_add(location=(0.0, -6.4, 0.34))
    camera = bpy.context.object
    camera.name = "Calibration Camera"
    camera.data.lens = 58
    camera.data.sensor_width = 36
    point_at(camera, (0.0, 0.0, -0.02))
    scene.camera = camera

    add_area_light("Key", (-3.8, -4.0, 4.8), 920.0, (0.48, 0.68, 1.0), 4.6)
    add_area_light("Rim", (3.7, 0.2, 2.6), 1150.0, (0.0, 0.40, 1.0), 3.4)
    add_area_light("Top", (0.0, 1.5, 5.8), 620.0, (0.28, 0.65, 1.0), 3.8)
    add_area_light("Front Fill", (0.0, -4.2, -0.3), 260.0, (0.35, 0.55, 0.85), 3.0)

    return {
        "root": root,
        "shell_material": shell_material,
        "seam_material": seam_material,
    }


def set_visual_values(objects: dict[str, object], energy: float) -> None:
    shell_shader = shader(objects["shell_material"])
    shell_shader.inputs["Base Color"].default_value = energy_ramp(
        energy,
        (0.002, 0.004, 0.006, 1.0),
        (0.014, 0.027, 0.040, 1.0),
        (0.020, 0.085, 0.145, 1.0),
    )
    shell_shader.inputs["Emission Strength"].default_value = energy_ramp(energy, 0.0, 0.16, 0.82)

    seam_shader = shader(objects["seam_material"])
    seam_shader.inputs["Base Color"].default_value = energy_ramp(
        energy,
        (0.001, 0.003, 0.005, 1.0),
        (0.006, 0.16, 0.25, 1.0),
        (0.035, 0.46, 0.72, 1.0),
    )
    seam_shader.inputs["Emission Strength"].default_value = energy_ramp(energy, 0.0, 1.15, 5.4)


def bake_animation(objects: dict[str, object]) -> None:
    root = objects["root"]
    shell_shader = shader(objects["shell_material"])
    seam_shader = shader(objects["seam_material"])

    for frame in range(FRAME_START - 1, FRAME_END + 2):
        pose = pose_for_frame(frame)
        root.rotation_euler.z = math.radians(pose.angle_degrees)
        root.keyframe_insert(data_path="rotation_euler", index=2, frame=frame)
        set_visual_values(objects, pose.energy)
        shell_shader.inputs["Base Color"].keyframe_insert(data_path="default_value", frame=frame)
        shell_shader.inputs["Emission Strength"].keyframe_insert(data_path="default_value", frame=frame)
        seam_shader.inputs["Base Color"].keyframe_insert(data_path="default_value", frame=frame)
        seam_shader.inputs["Emission Strength"].keyframe_insert(data_path="default_value", frame=frame)

    animation_owners = (
        root,
        objects["shell_material"].node_tree,
        objects["seam_material"].node_tree,
    )
    for owner in animation_owners:
        action = owner.animation_data.action if owner.animation_data is not None else None
        if action is None:
            continue
        for fcurve in action_fcurves(action):
            for keyframe in fcurve.keyframe_points:
                keyframe.interpolation = "LINEAR"

    bpy.context.scene.frame_set(FRAME_START)


def action_fcurves(action: bpy.types.Action) -> list[bpy.types.FCurve]:
    """Return curves from legacy actions and Blender 5 layered actions."""

    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    return [
        fcurve
        for layer in action.layers
        for strip in layer.strips
        for channelbag in strip.channelbags
        for fcurve in channelbag.fcurves
    ]


def main() -> None:
    options = parse_args()
    validate_timeline()
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    objects = setup_scene()
    bake_animation(objects)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))

    if options.smoke_frame is not None:
        frame = max(FRAME_START, min(FRAME_END, options.smoke_frame))
        bpy.context.scene.frame_set(frame)
        bpy.context.scene.render.filepath = str(EXAMPLE_DIR / "source" / f"smoke-{frame:04d}.png")
        bpy.ops.render.render(write_still=True)
        return

    if options.render:
        bpy.context.scene.render.filepath = str(FRAMES_DIR / "frame-")
        bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    main()
