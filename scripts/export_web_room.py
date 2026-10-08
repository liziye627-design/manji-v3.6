"""Export the V4 clean room as a portable, static Web GLB without altering V4.

Run: blender --background --python-exit-code 1 --python scripts/export_web_room.py
The sibling ConsensusBell-V4/reference/environment/home_room.blend is the source.
All evaluated geometry is merged by equivalent PBR material in memory. The huge
photography ground, lights and camera are excluded. Curves become real meshes.
"""
import bpy
import json
import math
import struct
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent/'ConsensusBell-V4'/'reference'/'environment'/'home_room.blend'
OUT = ROOT/'public'/'assets'/'models'
QA = ROOT/'qa'
OUT.mkdir(parents=True, exist_ok=True)
QA.mkdir(parents=True, exist_ok=True)

def numbers(v):
    return [round(float(x), 6) for x in v]

def coord(v):
    return [float(v[0]), float(v[2]), -float(v[1])]

def geometry_bounds(objects):
    dg=bpy.context.evaluated_depsgraph_get()
    points=[]
    for ob in objects:
        if ob.type not in {'MESH','CURVE','FONT','SURFACE'}:
            continue
        ev=ob.evaluated_get(dg)
        m=ev.to_mesh()
        points.extend(ev.matrix_world@v.co for v in m.vertices)
        ev.to_mesh_clear()
    lo=[min(p[i] for p in points) for i in range(3)]
    hi=[max(p[i] for p in points) for i in range(3)]
    return {'min':numbers((lo[0],lo[2],-hi[1])),
            'max':numbers((hi[0],hi[2],-lo[1]))}

def material_key(material):
    if material is None:
        return ('none',)
    p=next((n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
    if p is None:
        return ('unique',material.name)
    result=[]
    for name in ('Base Color','Metallic','Roughness','IOR','Alpha','Specular IOR Level',
                 'Transmission Weight','Coat Weight','Coat Roughness','Emission Color','Emission Strength'):
        value=p.inputs[name].default_value
        result.append((name,tuple(round(float(v),7) for v in value) if hasattr(value,'__iter__') else round(float(value),7)))
    return tuple(result)

bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
scene=bpy.context.scene
scene.frame_set(1)
bpy.context.view_layer.update()
original_objects=list(scene.objects)
geometry=[ob for ob in original_objects if ob.type in {'MESH','CURVE','FONT','SURFACE'} and ob.name!='Cream studio ground']
source_curve_count=sum(ob.type=='CURVE' for ob in geometry)
assert not any(str(ob.get('asset_id','')).startswith('dog_') or ob.name.lower().startswith('dog_') for ob in original_objects)
source_bounds=geometry_bounds(geometry)
roots=[ob for ob in original_objects if ob.get('asset_id')]
placed=[]
for ob in roots:
    placed.append({'name':ob.name,'assetId':ob['asset_id'],'position':numbers(coord(ob.matrix_world.translation)),
                   'bounds':geometry_bounds([ob]+list(ob.children_recursive))})
obstacle_ids={'sofa','coffee_table','floor_lamp','bookshelf','plant','window'}
obstacles=[]
for asset in placed:
    if asset['assetId'] in obstacle_ids:
        lo,hi=asset['bounds']['min'],asset['bounds']['max']
        obstacles.append({'id':asset['name'],'assetId':asset['assetId'],'xMin':lo[0],'xMax':hi[0],'zMin':lo[2],'zMax':hi[2]})
floorboards=[ob for ob in original_objects if ob.name.startswith('Staggered pale oak floorboard')]
floor_y=geometry_bounds(floorboards)['max'][1]
rug=next(ob for ob in geometry if ob.name.startswith('rug_soft_woven_base'))
rug_bounds=geometry_bounds([rug])
rug_lo,rug_hi=rug_bounds['min'],rug_bounds['max']
cam=scene.camera
cam_pos=coord(cam.matrix_world.translation)
cam_dir=cam.matrix_world.to_quaternion()@Vector((0,0,-1))
projection=cam.calc_matrix_camera(bpy.context.evaluated_depsgraph_get(),x=scene.render.resolution_x,y=scene.render.resolution_y)
slots={ob.name.removeprefix('SLOT_'):numbers(coord(ob.matrix_world.translation)) for ob in original_objects if ob.name.startswith('SLOT_')}
slots['side_wall']=[-2.90,2.10,0.10]
layout={
    'schemaVersion':1,
    'source':'ConsensusBell-V4/reference/environment/home_room.blend',
    'coordinateSystem':{'up':'+Y','front':'+Z','units':'metres','fromBlender':'[x,z,-y]'},
    'bounds':{'xMin':-2.93,'xMax':3.041,'zMin':-2.32,'zMax':2.509},
    'environmentBounds':source_bounds,
    'obstacles':obstacles,
    'agentRadius':0.38,
    'navigationNotes':['Bounds and obstacle AABBs are raw. Navigation must inset bounds and expand obstacles once by agentRadius.',
        'The connected roaming area is the front lounge. Furniture blocks access to the rear at this radius; unreachable targets must not teleport.',
        'Waypoints do not promise simultaneous clearance from the other dogs; use live agent avoidance.'],
    'groundY':0.09,
    'ground':{'floorY':floor_y,'footClearance':0.003,'edgeBlendWidth':0.12,
        'rug':{'cx':round((rug_lo[0]+rug_hi[0])/2,6),'cz':round((rug_lo[2]+rug_hi[2])/2,6),
               'rx':round((rug_hi[0]-rug_lo[0])/2,6),'rz':round((rug_hi[2]-rug_lo[2])/2,6),
               'heightY':rug_hi[1],'stitchTopY':0.080894}},
    'spawns':{'shiba':{'x':-1.43,'z':1.04,'yaw':0.24,'scale':0.78},
              'husky':{'x':-0.48,'z':0.64,'yaw':0.12,'scale':0.75},
              'pug':{'x':0.38,'z':1.28,'yaw':-0.22,'scale':0.82}},
    'waypoints':[
        {'id':'lounge_left','label':'沙发前左侧','x':-1.60,'z':0.75},
        {'id':'rug_front','label':'地毯前方','x':-0.70,'z':1.70},
        {'id':'table_left','label':'茶几左侧','x':0.24,'z':1.35},
        {'id':'left_front','label':'窗光里的地毯','x':-1.70,'z':1.60},
        {'id':'sofa_front','label':'沙发前','x':-0.55,'z':0.68},
        {'id':'front_edge','label':'地毯与木地板交界','x':-0.35,'z':2.00}],
    'camera':{'position':numbers(cam_pos),'target':[0,1.16,-0.1],
              'direction':numbers(coord(cam_dir)),'up':[0,1,0],
              'orthoHeight':round(cam.data.ortho_scale,6),
              'halfWidth':round(1/projection[0][0],6),'halfHeight':round(1/projection[1][1],6),
              'near':float(cam.data.clip_start),'far':float(cam.data.clip_end),
              'originalAspect':scene.render.resolution_x/scene.render.resolution_y,
              'fitBounds':source_bounds},
    'slots':slots,
    'placedAssets':placed,
    'materialNotes':'PBR base colour, metallic, roughness, emission and normals retained. Blender procedural textile noise is not a glTF texture; microscopic textile bump is omitted.'
}

# Flatten evaluated meshes into world-space, keeping exported corner normals and
# preserving every visible polygon. Equal PBR materials share one draw object.
dg=bpy.context.evaluated_depsgraph_get()
buckets={}
input_vertices=0
input_triangles=0
for ob in geometry:
    ev=ob.evaluated_get(dg)
    mesh=ev.to_mesh()
    mesh.calc_loop_triangles()
    input_vertices+=len(mesh.vertices)
    input_triangles+=len(mesh.loop_triangles)
    world=ev.matrix_world.copy()
    normal_matrix=world.to_3x3().inverted().transposed()
    source_materials=list(mesh.materials)
    maps={}
    for polygon in mesh.polygons:
        material=source_materials[polygon.material_index] if source_materials else None
        if material is not None:
            material=bpy.data.materials.get(material.name)
        key=material_key(material)
        bucket=buckets.setdefault(key,{'material':material,'vertices':[],'faces':[],'smooth':[],'normals':[]})
        index_map=maps.setdefault(key,{})
        face=[]
        face_normals=[]
        for loop_index in polygon.loop_indices:
            vertex_index=mesh.loops[loop_index].vertex_index
            if vertex_index not in index_map:
                index_map[vertex_index]=len(bucket['vertices'])
                bucket['vertices'].append(tuple(world@mesh.vertices[vertex_index].co))
            face.append(index_map[vertex_index])
            face_normals.append(tuple((normal_matrix@mesh.corner_normals[loop_index].vector).normalized()))
        if world.to_3x3().determinant()<0:
            face.reverse()
            face_normals.reverse()
        bucket['faces'].append(face)
        bucket['smooth'].append(polygon.use_smooth)
        bucket['normals'].extend(face_normals)
    ev.to_mesh_clear()

print('ROOM_GEOMETRY_FLATTENED',len(buckets),input_triangles,flush=True)
for ob in original_objects:
    bpy.data.objects.remove(ob,do_unlink=True)
root=bpy.data.objects.new('HomeRoom_Environment',None)
scene.collection.objects.link(root)
root['environment_version']='V4 geometry / V5 web export'
root['source_file']=layout['source']
for index,bucket in enumerate(buckets.values()):
    material=bucket['material']
    name='ENV_%02d_%s'%(index,material.name if material else 'Unpainted')
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(bucket['vertices'],[],bucket['faces'])
    mesh.update()
    for polygon,smooth in zip(mesh.polygons,bucket['smooth']):
        polygon.use_smooth=smooth
    mesh.normals_split_custom_set(bucket['normals'])
    if material:
        mesh.materials.append(material)
    ob=bpy.data.objects.new(name,mesh)
    scene.collection.objects.link(ob)
    ob.parent=root
print('ROOM_MESHES_MERGED',flush=True)
for name,position in slots.items():
    anchor=bpy.data.objects.new('SLOT_'+name,None)
    scene.collection.objects.link(anchor)
    anchor.parent=root
    anchor.location=(position[0],-position[2],position[1])
    anchor['slot_id']=name
bpy.ops.object.select_all(action='SELECT')
glb_path=OUT/'home-room.glb'
bpy.ops.export_scene.gltf(filepath=str(glb_path),export_format='GLB',use_selection=True,
    export_yup=True,export_apply=False,export_animations=False,export_cameras=False,
    export_lights=False,export_extras=True,export_materials='EXPORT',export_normals=True)
(OUT/'room-layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2),encoding='utf-8')

# Validate the actual portable GLB through a clean Blender re-import.
blob=glb_path.read_bytes()
magic,version,length=struct.unpack_from('<4sII',blob,0)
json_length,json_type=struct.unpack_from('<II',blob,12)
gltf=json.loads(blob[20:20+json_length])
assert magic==b'glTF' and version==2 and length==len(blob)
assert not gltf.get('animations') and not gltf.get('cameras')
assert all('uri' not in b for b in gltf.get('buffers',[]))
assert not gltf.get('images')
assert not any('dog_' in n.get('name','').lower() for n in gltf.get('nodes',[]))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(glb_path))
back_meshes=[ob for ob in bpy.context.scene.objects if ob.type=='MESH']
back_bounds=geometry_bounds(back_meshes)
back_triangles=0
for ob in back_meshes:
    ob.data.calc_loop_triangles()
    back_triangles+=len(ob.data.loop_triangles)
error=max(abs(a-b) for side in ('min','max') for a,b in zip(source_bounds[side],back_bounds[side]))
assert error<0.0001, (source_bounds,back_bounds)
assert input_triangles==back_triangles,(input_triangles,back_triangles)
assert not any(ob.type in {'CAMERA','LIGHT','ARMATURE'} for ob in bpy.context.scene.objects)
assert len(back_meshes)==len(buckets)
qa={'passed':True,'source':layout['source'],'glb':'public/assets/models/home-room.glb',
    'bytes':len(blob),'sourceGeometryObjects':len(geometry),'sourceCurves':source_curve_count,
    'sourceVertices':input_vertices,'sourceTriangles':input_triangles,'outputMeshes':len(back_meshes),
    'outputMaterials':len(gltf.get('materials',[])),'outputTriangles':back_triangles,
    'sourceBounds':source_bounds,'roundTripBounds':back_bounds,'maxBoundsErrorMetres':error,
    'externalFiles':0,'cameras':0,'lights':0,'dogs':0,'animations':0,
    'curveGeometryPreserved':True,'hugeStudioGroundRemoved':True,'slotAnchors':len(slots),
    'materialLimit':layout['materialNotes']}
(QA/'web-room-export.json').write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding='utf-8')
print('WEB_ROOM_EXPORT_OK '+json.dumps(qa,ensure_ascii=True),flush=True)
