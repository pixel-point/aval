"""Generate and render the deterministic kinetic-orb Blender scene."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


FPS = 24
FRAME_START = 0
FRAME_END = 95
SIZE = 512
EXAMPLE_DIR = Path(__file__).resolve().parents[1]
BLEND_PATH = EXAMPLE_DIR / "kinetic-orb.blend"
FRAMES_DIR = EXAMPLE_DIR / "source" / "frames"


def parse_args() -> argparse.Namespace:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--smoke-frame", type=int)
    return parser.parse_args(args)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def mix(start: float, end: float, amount: float) -> float:
    return start + (end - start) * amount


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
    shader = material.node_tree.nodes.get("Principled BSDF")
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


def great_circle_points(radius: float, phase: float, samples: int = 128) -> list[tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    for index in range(samples):
        angle = math.tau * index / samples
        local = Vector((radius * math.sin(angle), 0.0, radius * math.cos(angle)))
        local.rotate(Matrix.Rotation(phase, 4, "Z"))
        points.append(tuple(local))
    return points


def circle_points(radius: float, z: float, samples: int = 128) -> list[tuple[float, float, float]]:
    return [
        (
            radius * math.cos(math.tau * index / samples),
            radius * math.sin(math.tau * index / samples),
            z,
        )
        for index in range(samples)
    ]


def add_area_light(name: str, location: tuple[float, float, float], energy: float, color: tuple[float, float, float], size: float) -> None:
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


def setup_scene() -> dict[str, object]:
    clear_scene()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.fps = FPS
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
    scene.render.image_settings.color_depth = "8"
    scene.render.use_file_extension = True
    scene.render.filepath = str(FRAMES_DIR / "frame-")
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.72
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.exposure = 0.35

    world = bpy.data.worlds.new("Orb World") if bpy.data.worlds.get("Orb World") is None else bpy.data.worlds["Orb World"]
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.0015, 0.003, 0.007, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12
    scene.world = world

    shell_material = principled_material(
        "Graphite Shell",
        (0.012, 0.02, 0.028, 1.0),
        metallic=0.92,
        roughness=0.2,
        emission_color=(0.0, 0.32, 0.7, 1.0),
        emission_strength=0.03,
    )
    core_material = principled_material(
        "Energy Core",
        (0.002, 0.035, 0.055, 1.0),
        metallic=0.18,
        roughness=0.16,
        emission_color=(0.0, 0.42, 0.72, 1.0),
        emission_strength=0.3,
    )
    marker_material = principled_material(
        "Energy Markers",
        (0.04, 0.6, 1.0, 1.0),
        metallic=0.1,
        roughness=0.12,
        emission_color=(0.0, 0.65, 1.0, 1.0),
        emission_strength=0.0,
    )
    floor_material = principled_material(
        "Ground",
        (0.003, 0.006, 0.012, 1.0),
        metallic=0.25,
        roughness=0.32,
    )

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    root = bpy.context.object
    root.name = "Orb Root"
    root.rotation_mode = "XYZ"
    root.rotation_euler.x = math.radians(-11.0)
    root.rotation_euler.y = math.radians(18.0)

    shell = add_uv_sphere("Graphite Inner Shell", 1.06, shell_material)
    shell.parent = root
    bevel = shell.modifiers.new("Micro bevel", type="BEVEL")
    bevel.width = 0.012
    bevel.segments = 2

    core = add_uv_sphere("Energy Core", 0.72, core_material, segments=64, rings=48)
    core.parent = root

    rib_materials: list[bpy.types.Material] = []
    for index in range(6):
        material = principled_material(
            f"Rib Glow {index + 1:02d}",
            (0.002, 0.08, 0.13, 1.0),
            metallic=0.3,
            roughness=0.18,
            emission_color=(0.0, 0.55, 1.0, 1.0),
            emission_strength=0.5,
        )
        rib_materials.append(material)
        rib = add_curve_loop(
            f"Meridian Rib {index + 1:02d}",
            great_circle_points(1.468, math.radians(index * 30.0)),
            0.018,
            material,
        )
        rib.parent = root

    accent_material = principled_material(
        "Latitude Glow",
        (0.002, 0.05, 0.08, 1.0),
        metallic=0.3,
        roughness=0.18,
        emission_color=(0.0, 0.42, 0.82, 1.0),
        emission_strength=0.28,
    )
    for index, z in enumerate((-0.64, 0.0, 0.64), start=1):
        radius = math.sqrt(max(0.0, 1.468 * 1.468 - z * z))
        latitude = add_curve_loop(f"Latitude {index:02d}", circle_points(radius, z), 0.012, accent_material)
        latitude.parent = root

    marker_root = bpy.data.objects.new("Marker Root", None)
    bpy.context.collection.objects.link(marker_root)
    marker_root.parent = root
    for index in range(12):
        angle = math.tau * index / 12
        bpy.ops.mesh.primitive_uv_sphere_add(
            segments=24,
            ring_count=16,
            radius=0.065,
            location=(0.56 * math.cos(angle), 0.56 * math.sin(angle), 0.08 * math.sin(angle * 2)),
        )
        marker = bpy.context.object
        marker.name = f"Inner Marker {index + 1:02d}"
        marker.data.materials.append(marker_material)
        marker.parent = marker_root

    bpy.ops.mesh.primitive_plane_add(size=24.0, location=(0.0, 0.0, -1.62))
    floor = bpy.context.object
    floor.name = "Ground Plane"
    floor.data.materials.append(floor_material)

    bpy.ops.object.camera_add(location=(0.0, -7.7, 0.55))
    camera = bpy.context.object
    camera.name = "Orb Camera"
    camera.data.lens = 58
    camera.data.sensor_width = 36
    point_at(camera, (0.0, 0.0, 0.0))
    scene.camera = camera

    add_area_light("Key", (-3.8, -4.2, 5.4), 1050.0, (0.28, 0.58, 1.0), 4.2)
    add_area_light("Rim", (4.1, 0.5, 3.0), 1280.0, (0.0, 0.34, 1.0), 3.1)
    add_area_light("Top", (0.0, 1.0, 6.5), 850.0, (0.22, 0.72, 1.0), 3.2)
    add_area_light("Softbox", (0.0, -4.6, -0.4), 420.0, (0.3, 0.55, 1.0), 2.0)

    return {
        "root": root,
        "marker_root": marker_root,
        "core_material": core_material,
        "shell_material": shell_material,
        "marker_material": marker_material,
        "rib_materials": rib_materials,
        "accent_material": accent_material,
    }


def shader(material: bpy.types.Material) -> bpy.types.Node:
    return material.node_tree.nodes["Principled BSDF"]


def pose_for_frame(frame: float) -> tuple[float, float, float, float]:
    if frame < 24.0:
        t = max(0.0, frame) / 23.0
        angle = (-2 * t**3 + 3 * t**2) * 165.0 + (t**3 - t**2) * 345.0
        energy = mix(0.0, 0.22, smoothstep(t))
        return angle, energy, 0.0, t
    if frame < 48.0:
        local = frame - 24.0
        return local * 15.0, 0.2 + 0.025 * math.sin(math.tau * local / 24.0), 0.0, 1.0
    if frame < 60.0:
        local = frame - 48.0
        progress = smoothstep((local + 1.0) / 12.0)
        return local * 15.0, mix(0.22, 1.0, progress), progress, 1.0
    if frame < 84.0:
        local = frame - 60.0
        energy = 0.9 + 0.1 * math.cos(math.tau * local / 24.0)
        return local * 15.0, energy, 1.0, 1.0
    local = frame - 84.0
    progress = smoothstep((local + 1.0) / 12.0)
    return local * 15.0, mix(1.0, 0.22, progress), 1.0 - progress, 1.0


def install_animation_handler(objects: dict[str, object]) -> None:
    def apply_pose(scene: bpy.types.Scene, _depsgraph: bpy.types.Depsgraph | None = None) -> None:
        frame = scene.frame_current + scene.frame_subframe
        angle, core_energy, marker_energy, intro_energy = pose_for_frame(frame)
        root = objects["root"]
        root.rotation_euler.z = math.radians(angle)
        marker_root = objects["marker_root"]
        marker_root.rotation_euler.z = math.radians(angle * 1.7)
        marker_root.scale = (1.0 + marker_energy * 0.08,) * 3

        core_shader = shader(objects["core_material"])
        core_shader.inputs["Emission Strength"].default_value = mix(0.18, 7.5, core_energy)
        core_shader.inputs["Base Color"].default_value = (
            mix(0.002, 0.01, core_energy),
            mix(0.025, 0.16, core_energy),
            mix(0.045, 0.34, core_energy),
            1.0,
        )
        marker_shader = shader(objects["marker_material"])
        marker_shader.inputs["Emission Strength"].default_value = marker_energy * 12.0

        activation = max(0.0, min(1.0, (core_energy - 0.22) / 0.78))
        shell_shader = shader(objects["shell_material"])
        shell_shader.inputs["Emission Strength"].default_value = mix(0.03, 1.55, activation)
        shell_shader.inputs["Base Color"].default_value = (
            mix(0.012, 0.008, activation),
            mix(0.02, 0.11, activation),
            mix(0.028, 0.24, activation),
            1.0,
        )

        for index, material in enumerate(objects["rib_materials"]):
            charge = smoothstep((intro_energy * 7.5) - index)
            strength = mix(0.08, 2.2, charge) + marker_energy * 1.8
            shader(material).inputs["Emission Strength"].default_value = strength
        shader(objects["accent_material"]).inputs["Emission Strength"].default_value = 0.35 + marker_energy * 2.2

    bpy.app.handlers.frame_change_pre.clear()
    bpy.app.handlers.frame_change_pre.append(apply_pose)
    bpy.context.scene.frame_set(FRAME_START)
    apply_pose(bpy.context.scene)


def main() -> None:
    options = parse_args()
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    objects = setup_scene()
    install_animation_handler(objects)
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
