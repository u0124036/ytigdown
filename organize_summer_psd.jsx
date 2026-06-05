function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function renameMatching(layers, map) {
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (map[layer.name]) {
      layer.name = map[layer.name];
    }
    if (layer.typename === "LayerSet") {
      renameMatching(layer.layers, map);
    }
  }
}

function prefixGenericChildren(group, prefix) {
  var count = 1;
  for (var i = group.layers.length - 1; i >= 0; i--) {
    var layer = group.layers[i];
    if (layer.typename === "LayerSet") continue;
    if (/^(圖層|照片|Rectangle)\b/.test(layer.name)) {
      layer.name = prefix + "_" + pad2(count) + " (" + layer.name + ")";
      count++;
    }
  }
}

function findGroup(layers, name) {
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (layer.typename === "LayerSet" && layer.name === name) return layer;
    if (layer.typename === "LayerSet") {
      var found = findGroup(layer.layers, name);
      if (found) return found;
    }
  }
  return null;
}

var doc = app.activeDocument;

renameMatching(doc.layers, {
  "LOGO": "04_Title & Logo",
  "資料夾 2": "04_Title Decoration / Badge",
  "bottom": "09_Bottom UI",
  "center": "09_Center CTA",
  "Character": "07_Character & Main Props",
  "RyuNa －line": "07A_Character Line / Details",
  "Drink": "07B_Drink Prop",
  "Ryan": "07C_Character Body",
  "Chair- fin": "08_Chair Final",
  "Chair. Old": "_Archive / Old Chair",
  "leaves": "03_Foreground Leaves & Flowers",
  "bg": "01_Background Base",
  "最初高清圖": "00_Original Flattened Artwork",
  "background": "00_Background Color Base"
});

var groupPrefixes = {
  "04_Title & Logo": "title_logo",
  "04_Title Decoration / Badge": "title_badge",
  "09_Bottom UI": "bottom_ui",
  "09_Center CTA": "center_cta",
  "07A_Character Line / Details": "character_line",
  "07B_Drink Prop": "drink",
  "07C_Character Body": "character_body",
  "08_Chair Final": "chair_final",
  "_Archive / Old Chair": "old_chair",
  "03_Foreground Leaves & Flowers": "foreground_leaves",
  "01_Background Base": "background_base"
};

for (var groupName in groupPrefixes) {
  var group = findGroup(doc.layers, groupName);
  if (group) prefixGenericChildren(group, groupPrefixes[groupName]);
}

doc.save();
"organized";
