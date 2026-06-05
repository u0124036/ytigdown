var doc = app.activeDocument;

function visit(layers) {
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (
      layer.name === "照片1 2 2" ||
      layer.name === "00_Original Flattened Artwork" ||
      layer.name === "照片1" ||
      layer.name === "照片4" ||
      layer.name === "照片3"
    ) {
      layer.visible = false;
    }
    if (layer.typename === "LayerSet") {
      visit(layer.layers);
    }
  }
}

visit(doc.layers);
doc.save();
"fixed_visibility";
