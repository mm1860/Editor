import {
    Engine, Scene, ArcRotateCamera, PointLight, Vector3, Node,
    Observer, Tags,
    SceneSerializer, SceneLoader, InstancedMesh,
    ParticleSystem, FilesInputStore,
    SerializationHelper, AbstractMesh
} from 'babylonjs';

import Editor, {
    EditorPlugin, Tools,
    Layout, Toolbar, Tree,
    Prefab, PrefabNodeType,
} from 'babylonjs-editor';

export default class PrefabEditor extends EditorPlugin {
    // Public members
    public layout: Layout = null;
    public toolbar: Toolbar = null;
    public tree: Tree = null;

    public engine: Engine = null;
    public scene: Scene = null;
    public camera: ArcRotateCamera = null;
    public pointLight: PointLight = null;

    // Protected members
    protected selectedAsset: Prefab = null;
    protected selectedPrefab: Node = null;

    protected onObjectSelected: Observer<any> = null;
    protected onAssetSelected: Observer<any> = null;
    protected onObjectPropertyChanged: Observer<any> = null;

    protected selectingNode: boolean = false;
    protected masterNode: Node = null;

    // Static members
    private static _TreeRootId: string = 'prefab_root';

    /**
     * Constructor
     * @param name: the name of the plugin 
     */
    constructor(public editor: Editor, asset: Prefab = null) {
        super('Prefab Editor');
        this.selectedAsset = asset;
    }

    /**
     * Closes the plugin
     */
    public async close (): Promise<void> {
        // Engine
        this.scene.dispose();
        this.engine.dispose();

        // UI
        this.toolbar.element.destroy();
        this.layout.element.destroy();

        // Events
        this.editor.core.onSelectObject.remove(this.onObjectSelected);
        this.editor.core.onSelectAsset.remove(this.onAssetSelected);
        this.editor.core.onObjectPropertyChange.remove(this.onObjectPropertyChanged);

        await super.close();
    }

    /**
     * Creates the plugin
     */
    public async create(): Promise<void> {
        // Layout
        this.layout = new Layout(this.divElement.id);
        this.layout.panels = [
            { type: 'top', resizable: false, size: 30, content: '<div id="PREFAB-EDITOR-TOOLBAR" style="width: 100%; height: 100%;"></div>' },
            { type: 'left', resizable: true, size: '50%', content: '<div id="PREFAB-EDITOR-TREE" style="width: 100%; height: 100%;"></div>' },
            { type: 'main', resizable: true, size: '50%', content: '<canvas id="PREFAB-EDITOR-PREVIEW" style="width: 100%; height: 100%; position: absolute; top: 0;"></canvas>' }
        ];
        this.layout.build(this.divElement.id);

        // Toolbar
        this.toolbar = new Toolbar('PREFAB-EDITOR-TOOLBAR');
        this.toolbar.helpUrl = 'https://doc.babylonjs.com/resources/editing_prefabs';
        this.toolbar.build('PREFAB-EDITOR-TOOLBAR');
        this.toolbar.notifyMessage('<h2>No prefab selected</h2>');
        this.toolbar.notifyMessage('No prefab selected');

        // Grid
        this.tree = new Tree('PREFAB-EDITOR-TREE');
        this.tree.wholerow = true;
        this.tree.multipleSelection = true;
        this.tree.onCanDrag = (id, data) => false;
        this.tree.onClick = (id, data: any) => {
            const node = this.tree.getSelected();
            if (node.id !== PrefabEditor._TreeRootId && node.data.id !== 0) {
                this.selectingNode = true;
                const effectiveObject = this.masterNode.getDescendants()[node.data.id - 1]; // Emmit master
                this.editor.core.onSelectObject.notifyObservers(effectiveObject);
                this.selectingNode = false;
            }
        };
        this.tree.onContextMenu = (id, data: any) => {
            return (id === PrefabEditor._TreeRootId) ? [] : [{ id: 'delete', text: 'Delete', img: 'icon-error', callback: () => {
                const node = this.tree.getSelected();
                const children = node.children.map(c => this.tree.get(c).data.id);
                this.deleteInstances([node.data.id].concat(children));
            }}];
        };
        this.tree.build('PREFAB-EDITOR-TREE');

        // Select
        this.assetSelected(this.selectedAsset);

        // Events
        this.onObjectSelected = this.editor.core.onSelectObject.add(node => this.objectSelected(node));
        this.onAssetSelected = this.editor.core.onSelectAsset.add(asset => this.assetSelected(asset));
        this.onObjectPropertyChanged = this.editor.core.onObjectPropertyChange.add(p => this.objectPropertyChanged(p.object));
    }

    /**
     * Called on the window, layout etc. is resized.
     */
    public onResize (): void {
        this.layout.element.resize();
        this.engine.resize();
    }

    /**
     * Resets the prefab editor when no prefab selected
     */
    protected setNoPrefabSelected (): void {
        this.selectedPrefab = null;
        this.selectedAsset = null;

        this.toolbar.notifyMessage('<h2>No prefab selected</h2>');
        this.layout.lockPanel('left', 'No Prefab Selected');

        this.tree.clear();
        this._createNewScene(null);
    }

    /**
     * Called on the user modifies an object
     * @param node the node being modified in the current scene of the prefab editor tool
     */
    protected objectPropertyChanged (node: Node): void {
        if (!(node instanceof Node) || !this.scene.getNodeByID(node.id))
            return;

        const data = node instanceof AbstractMesh ? SceneSerializer.SerializeMesh(node, false, false).meshes[0] : node['serialize']();
        const assets = this.editor.assets.prefabs.datas;

        assets.forEach(a => {
            const instances = a.data.sourceInstances;
            for (const i in instances) {
                const inst = instances[i];

                inst.forEach(i => {
                    if (i['metadata'].prefab.id === node['metadata'].prefab.id)
                        SerializationHelper.Parse(() => i, data, this.scene, 'file:');
                });
            }
        });
    }

    /**
     * Once the user selects an object in the scene
     * @param node the selected node
     */
    protected objectSelected (node: Node): void {
        if (this.selectingNode)
            return;
        
        if (!node || !Tags.HasTags(node) || !Tags.MatchesQuery(node, 'prefab-master'))
            return this.setNoPrefabSelected();

        // Unlock
        this.layout.unlockPanel('left');

        // Misc.
        this.selectedPrefab = node;
        this.selectedAsset = null;

        // Update grid
        const descendants = [node].concat(node.getDescendants());

        this.tree.clear();
        this.tree.add({ id: PrefabEditor._TreeRootId, text: 'Prefab', img: 'icon-scene', data: node });

        descendants.forEach((n, index) => {
            const parent = n instanceof InstancedMesh ? n.sourceMesh.parent : n.parent;
            const parentNode = parent ? this.tree.get(parent.id) : null;
            const parentId = parentNode ? parentNode.id : PrefabEditor._TreeRootId;
            this.tree.add({ id: n.id, img: this.editor.graph.getIcon(n), text: n.name, data: { id: index } }, parentId);

            if (parentId)
                this.tree.expand(parentId);
        });

        // Create new scene
        this._createNewScene(node['sourceMesh'] || node, <InstancedMesh> node);

        // Notify
        this.toolbar.notifyMessage(`Selected object: <h2>${node.name}</h2>`);
    }

    /**
     * Once the user selects an asset in the assets panel of the editor
     * @param asset the selected asset
     */
    protected async assetSelected (prefab: Prefab): Promise<void> {
        if (!prefab || !prefab.isPrefab)
            return this.setNoPrefabSelected();

        // Unlock
        this.layout.unlockPanel('left');

        // Misc.
        this.selectedPrefab = null;
        this.selectedAsset = prefab;

        // Update grid
        this.tree.clear();
        this.tree.add({ id: PrefabEditor._TreeRootId, text: 'Prefab', img: 'icon-scene', data: prefab });

        prefab.nodeIds.forEach((id, index) => {
            const n = this.editor.core.scene.getNodeByID(id);
            const parent = n.parent ? this.tree.get(n.parent.id) : null;
            const parentId = parent ? parent.id : PrefabEditor._TreeRootId;

            this.tree.add({ id: n.id, img: this.editor.graph.getIcon(n), text: n.name, data: { id: index } }, parentId);
            if (parentId)
                this.tree.expand(parentId);
        });

        // Create new scene
        this._createNewScene(<Node> prefab.sourceNode, null);

        // Notify
        const asset = this.editor.assets.prefabs.datas.find(d => d.data === prefab);
        this.toolbar.notifyMessage(`Selected asset: <h2>${asset.name}</h2>`);
    }

    /**
     * On the user deletes nodes from the prefab
     * @param ids the ids of the items to delete
     */
    protected deleteInstances (ids: number[]): void {
        // The user selected an object in scene?
        // So remove nodes only from the selected prefab in the scene
        if (this.selectedPrefab) {
            const descendants = [this.selectedPrefab].concat(this.selectedPrefab.getDescendants());
            const asset = this.editor.assets.prefabs.getAssetFromNode(<PrefabNodeType> this.selectedPrefab);

            // Remove each selected prefab instance
            for (let descendantIndex = 0; descendantIndex < ids.length; descendantIndex++) {
                // Get instance
                const inst = descendants[ids[descendantIndex]];
                const prefabSource = inst['sourceMesh'] || inst;

                // Removed source instance?
                if (prefabSource === asset.data.sourceNode) {
                    // Remove all
                    for (const si in asset.data.sourceInstances) {
                        const instances = asset.data.sourceInstances[si];

                        for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex++) {
                            const i = instances[instanceIndex];
                            if ((<InstancedMesh> i).parent === inst || (<ParticleSystem> i).emitter === i) {
                                i.dispose();
                                instances.splice(instanceIndex, 1);
                                instanceIndex--;
                            }
                        }
                    }

                    // Dispose instance
                    inst.dispose();
                    const sourceInstances = asset.data.sourceInstances[prefabSource.id] || asset.data.sourceInstances[prefabSource.name];
                    const index = sourceInstances.indexOf(<PrefabNodeType> inst);
                    sourceInstances.splice(index, 1);

                    this.tree.clear();
                    break;
                }

                // Dispose instance
                inst.dispose();

                // Remove from source instances
                const sourceInstances = asset.data.sourceInstances[prefabSource.id] || asset.data.sourceInstances[prefabSource.name];
                const index = sourceInstances.indexOf(<PrefabNodeType> inst);
                if (index !== -1)
                    sourceInstances.splice(index, 1);

                // Remove from preview
                const previewNode = this.scene.getNodeByID(inst.id) || this.scene.getNodeByName(inst.name) || this.scene.getParticleSystemByID(inst.id);
                if (previewNode)
                    previewNode.dispose();
            }

            // Remove node from graph?
            if (this.tree.getNodesCount() === 0) {
                this._createNewScene(null);
                this.editor.graph.tree.remove(this.selectedPrefab.id);
                this.selectedPrefab = null;
            }
            else {
                this.objectSelected(this.selectedPrefab);
            }
        }
        // The user selected an asset?
        // So remove all nodes from scene instances of the node in the asset
        else {
            for (let instanceIndex = 0, offset = 0; instanceIndex < ids.length; instanceIndex++) {
                const index = ids[instanceIndex] - offset;
                const source = this.selectedAsset.sourceNodes[index];

                if (source === this.selectedAsset.sourceNode) {
                    // Remove all
                    this.selectedAsset.sourceNodes = [];
                    this.selectedAsset.nodes = [];
                    this.selectedAsset.nodeIds = [];
                    break;
                }

                // Remove references from scene and asset
                const sourceInstances = this.selectedAsset.sourceInstances[source.id] || this.selectedAsset.sourceInstances[source.name];
                sourceInstances.forEach(si => {
                    si.dispose();
                    const graphNode = this.editor.graph.getByData(si);
                    if (graphNode)
                        this.editor.graph.tree.remove(graphNode.id);
                });
                sourceInstances.splice(0, sourceInstances.length);

                this.selectedAsset.sourceNodes.splice(index, 1);
                this.selectedAsset.nodes.splice(index, 1);
                this.selectedAsset.nodeIds.splice(index, 1);

                // Remove from preview
                const previewNode = this.scene.getNodeByID(source.id) || this.scene.getNodeByName(source.name) || this.scene.getParticleSystemByID(source.id);
                if (previewNode)
                    previewNode.dispose();
                
                // Offset in ids
                offset++;
            }

            // Remove node from graph and asset?
            if (this.selectedAsset.sourceNodes.length === 0) {
                const asset = this.editor.assets.prefabs.getAssetFromNode(<PrefabNodeType> this.selectedAsset.sourceNode);
                this.editor.assets.prefabs.onRemoveAsset(asset);
                this._createNewScene(null);
                this.tree.clear();
            }
            else {
                this.assetSelected(this.selectedAsset);
            }
        }
    }

    // Creates a new scene with the selected node prefab
    private async _createNewScene (node: Node, instance?: InstancedMesh): Promise<void> {
        // Create new scene
        this._createBaseSceneElements();

        // Check availability
        if (!(node instanceof Node)) {
            return this.layout.lockPanel('main', 'Cannot create preview');
        }

        this.layout.unlockPanel('main');

        // Get meshes names
        const meshesNames = instance ? [<Node> instance].concat(instance.getDescendants()).map(d => d instanceof InstancedMesh ? d.sourceMesh.name : d.name) :
                                       [node].concat(node.getDescendants()).map(d => d.name);

        // If selected an asset, remove the previously removed/unused nodes
        if (this.selectedAsset) {
            for (let i = 0; i < meshesNames.length; i++) {
                if (this.selectedAsset.nodes.indexOf(meshesNames[i]) === -1) {
                    meshesNames.splice(i, 1);
                    i--;
                }
            }
        }

        // Load scene with prefabs
        const serializedObject = SceneSerializer.SerializeMesh(node, false, true);
        const file = Tools.CreateFile(Tools.ConvertStringToUInt8Array(JSON.stringify(serializedObject)), 'prefab.babylon');

        FilesInputStore.FilesToLoad[file.name.toLowerCase()]= file;
        await SceneLoader.ImportMeshAsync(null, 'file:' ,'prefab.babylon', this.scene);
        delete FilesInputStore.FilesToLoad[file.name.toLowerCase()];

        // Clear unused meshes
        for (let i = 0; i < this.scene.meshes.length; i++) {
            const m = this.scene.meshes[i];

            if (meshesNames.indexOf(m.name) === -1) {
                m.dispose();
                i--;
            }
        }

        if (this.scene.lights.length === 0)
            this.pointLight = new PointLight('PrefabEditorLight', new Vector3(15, 15, 15), this.scene);

        // Place master prefab
        this.masterNode = this.scene.getNodeByID(node.id);
        this.masterNode['position'] = Vector3.Zero();
    }

    // Creates the base scene elements (camera)
    private _createBaseSceneElements (): void {
        if (this.engine)
            this.engine.dispose();

        if (this.scene)
            this.scene.dispose();
        
        this.engine = new Engine(<HTMLCanvasElement> $('#PREFAB-EDITOR-PREVIEW')[0]);

        this.scene = new Scene(this.engine);
        this.scene.clearColor.set(0, 0, 0, 1);

        this.camera = new ArcRotateCamera('PrefabEditorCamera', Math.PI / 2, Math.PI / 2, 15, Vector3.Zero(), this.scene);
        this.scene.render();

        this.camera.attachControl(this.engine.getRenderingCanvas(), false, false);

        // Render loop
        this.engine.runRenderLoop(() => this.scene.render());
    }
}
