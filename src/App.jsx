import React, { useRef, useEffect, useState } from 'react'
import Toolbar from './toolbar/Toolbar.jsx'
import Header from './header/Header.jsx'
import { fabric } from 'fabric'
import * as fabricEvents from './fabricEvents.js'
import * as constants from './constants.js'
import * as utils from './utils.js'
import FixedStack from './FixedStack.js'

// Change defaults
fabric.Group.prototype.hasControls = false;

function App() {
  const canvasRef = useRef(null);
  const fabRef = useRef(null);

  const [stateView, setStateView] = useState(null);

  useEffect(() => {
    // Initialize fabric
    fabRef.current = new fabric.Canvas(canvasRef.current, {
      // static(-ish) parameters
      backgroundColor: constants.BACKGROUND_COLOR,
      width: window.outerWidth,
      height: window.outerHeight,
      selectionFullyContained: true, // watch for better selection feature: https://github.com/fabricjs/fabric.js/issues/3773
      preserveObjectStacking: true,
      hoverCursor: 'pointer',
      hasControls: false,

      // NOTE: Canvas parameters that vary over time are changed in 
      // resetCanvasState(). (The default parameters are fine for select mode)

      // State, copied to stateView to be shared with React components
      state: {
        // User parameters
        mode: 'select',     // 'select' | 'pan' | 'draw' | 'delete'
        drawMode: 'point',  // 'point' | 'line' | 'freehand'
        snap: true,

        curPos: {x: 0, y: 0}, // TODO(?) curPos may be updated too frequently but I think it is ok for now
        undoStack: new FixedStack(constants.MAX_HISTORY_LENGTH),
        redoStack: new FixedStack(constants.MAX_HISTORY_LENGTH),
        selectionExists: false,
        clipboard: null,
        curMetaPoint: null,
        disableUndo: false,
        disableModeSwitch: false,
        // Note: everything below here may be unused by react components
        // Could separate out.
        isDragging: false,      
        isBending: false,
        p1: null,
        p2: null,
        p3: null,
        originalLine: null,
        curLine: null,
        isDeleting: false,
        lastPosX: null,
        lastPosY: null,
        bg: null,
      },
    });
    let canvas = fabRef.current;

    // Attach background grid
    let bg = new utils.infBGrid();
    canvas.state.bg = bg;
    bg.evented = bg.selectable = false;
    bg.excludeFromExport = true;
    canvas.add(bg);

    // Attach brush
    let brush = new fabric.PencilBrush(canvas);
    brush.color = constants.DRAW_COLOR;
    brush.width = constants.LINE_WIDTH;
    canvas.freeDrawingBrush = brush;

    // Fabric events handlers
    canvas.on({
      'saveState': (opt) => fabricEvents.handleSaveState(opt, canvas, setStateView),
      'path:created': (opt) => fabricEvents.handlePathCreated(opt, canvas),
      'mouse:wheel': (opt) => fabricEvents.handleScroll(opt, canvas),
      'mouse:dblclick': (opt) => fabricEvents.handleDoubleClick(opt, canvas),
      'mouse:down': (opt) => fabricEvents.handleMouseDown(opt, canvas),
      'mouse:move': (opt) => fabricEvents.handleMouseMove(opt, canvas),
      'mouse:up': (opt) => fabricEvents.handleMouseUp(opt, canvas),
      'selection:created': (opt) => fabricEvents.handleSelectionCreated(opt, canvas),
      'selection:updated': (opt) => fabricEvents.handleSelectionUpdated(opt, canvas),
      'selection:cleared': (opt) => fabricEvents.handleSelectionCleared(opt, canvas),
      'before:transform': (opt) => {
        canvas.state.disableModeSwitch = canvas.state.disableUndo = true;
      },
      'object:modified': (opt) => fabricEvents.handleObjectModified(opt, canvas),
    });

    window.onresize = function() {
      canvas.setWidth(window.outerWidth);
      canvas.setHeight(window.outerHeight);
    };
    
    // Initialize in drawing mode and render canvas
    utils.resetCanvasState(canvas);

    // Cleanup on unmount
    return () => {
      fabRef.current.dispose();
    };
  }, []);
  
  // =====================================================================
  // Handlers for user-initiated events
  //

  function handleMode(event, newMode){
    let canvas = fabRef.current;
    if (canvas.state.disableModeSwitch || !newMode) return;
    canvas.state.mode = newMode;
    utils.resetCanvasState(canvas);
  };

  function handleDrawMode(event, newDrawMode) {
    let canvas = fabRef.current;
    if (canvas.state.disableModeSwitch || !newDrawMode) return;
    if (canvas.state.mode!=='draw') {
      console.log("Unexpected behavior in App.jsx:handleDrawMode");
      return;
    }
    canvas.state.drawMode = newDrawMode;
    utils.resetCanvasState(canvas);
  }

  function handleSnap(event) {
    let canvas = fabRef.current;
    canvas.state.snap = event.target.checked;
    canvas.fire('saveState');
  }

  function handleRemoveMeta() {
    let canvas = fabRef.current;
    utils.resetMetaPointState(canvas);
    canvas.fire('saveState');
  }

  function handleCopy() {
    let canvas = fabRef.current;
    if (!canvas.state.curMetaPoint || !canvas.state.selectionExists) {
      console.log('Unexpected behavior in handleCopy()');
      return;
    }

    canvas.getActiveObject().clone(function(clonedObj) {
      let metaPoint = canvas.state.curMetaPoint;
      clonedObj.metaOffsetX = clonedObj.left - metaPoint.aCoords.tl.x;
      clonedObj.metaOffsetY = clonedObj.top - metaPoint.aCoords.tl.y;
      canvas.state.clipboard = clonedObj;
      
    }, [...Object.keys(utils.defaultCircle), ...Object.keys(utils.defaultPath)]);
    
    canvas.fire('saveState');
  }

  function handlePaste() {
    let commandToSave;
    let canvas = fabRef.current;
    if (!canvas.state.clipboard || !canvas.state.curMetaPoint) return;
  
    let metaPoint = canvas.state.curMetaPoint;
    // clone again, so you can do multiple copies.
    canvas.state.clipboard.clone(function(clonedObj) {
      clonedObj.set({
        left: metaPoint.aCoords.tl.x + clonedObj.metaOffsetX,
        top: metaPoint.aCoords.tl.y + clonedObj.metaOffsetY,
        evented: true,
      });
      if (clonedObj.type === 'activeSelection') {
        // active selection needs a reference to the canvas.
        clonedObj.canvas = canvas;
        clonedObj.forEachObject(function(obj) {
          canvas.add(obj);
        });
        // this should solve the unselectability
        clonedObj.setCoords();

        commandToSave = {
          action: 'add',
          objects: clonedObj.getObjects(),
        }
      } else {
        canvas.add(clonedObj);
        commandToSave = {
          action: 'add',
          objects: [clonedObj],
        }
      }
      canvas.bringToFront(metaPoint);
      canvas.setActiveObject(clonedObj);
      canvas.requestRenderAll();
    }, [...Object.keys(utils.defaultCircle), ...Object.keys(utils.defaultPath), 'metaOffsetX', 'metaOffsetY']);

    canvas.fire('saveState', commandToSave);
  }

  function handleDelete() {
    let canvas = fabRef.current;
    let activeObjects = canvas.getActiveObjects();
    canvas.discardActiveObject();
    canvas.remove(...activeObjects);
    canvas.fire('saveState', {
      action: 'remove',
      objects: activeObjects,
    });
  }

  // Handle a rotation of 90 degrees
  function handleRotate() {
    let canvas = fabRef.current;
    let activeObject = canvas.getActiveObject();
    if (!activeObject || !canvas.state.curMetaPoint) {
      console.log("Unexpected behavior in handleRotate()");
      return;
    }

    let newCoords = fabric.util.rotatePoint(
      new fabric.Point(activeObject.left, activeObject.top), // point to rotate
      canvas.state.curMetaPoint.getCenterPoint(), // rotation origin
      fabric.util.degreesToRadians(90), // angle
    )

    activeObject
      .set({left: newCoords.x, top: newCoords.y, angle: activeObject.get("angle") + 90})
      .setCoords();

    canvas.fire('saveState', {
      action: 'rotate',
      origin: canvas.state.curMetaPoint.getCenterPoint(),
      objects: canvas.getActiveObjects(),
    });
  }

  function handleReflect() {

  }

  // make sure to use call parameters w/ absolute coordinates
  function handlePrint(x, y, width, height, scale) {
    let canvas = fabRef.current;
    utils.resetCanvasState(canvas);

    // Create a temp canvas representing our print selection (white background, no grid)
    canvas.remove(canvas.state.bg);
    canvas.backgroundColor = 'white';
    let tempCanvas = new fabric.StaticCanvas().loadFromJSON(canvas.toJSON());
    canvas.backgroundColor = constants.BACKGROUND_COLOR;
    canvas.add(canvas.state.bg);
    canvas.sendToBack(canvas.state.bg);
    
    tempCanvas.setHeight(height);
    tempCanvas.setWidth(width);
    tempCanvas.absolutePan({x, y});
    let dataURL = tempCanvas.toDataURL({  // our image!
      multiplier: scale,
    });
    tempCanvas.dispose();
    
    // Plop dataUrl into new window and print
    let title = "title";
    let windowContent = `
    <!DOCTYPE html>
    <html>
    <head><title>${title}</title></head>
    <body><img src="${dataURL}" onload=window.print()></body>
    </html>
    `;
    let printWin = window.open();
    printWin.document.open();
    printWin.document.write(windowContent);
    printWin.document.close();
  }

  // handler 'handleExport()' can be managed by component, just have a getter
  function getExportJSON() {
    let canvas = fabRef.current;
    utils.resetCanvasState(canvas);

    let exportJSON = JSON.stringify(canvas.toJSON(
      [...Object.keys(utils.defaultCircle), ...Object.keys(utils.defaultPath)],
    ), null, 2);

    return exportJSON;
  }

  function handleImport(importJSON) {
  
    let canvas = fabRef.current;
    utils.resetCanvasState(canvas);
    let state = canvas.state;
    try {
      canvas.loadFromJSON(importJSON);
    } catch (error) {
      alert('Invalid JSON format. Please correct and try again.');
    }
    canvas.state = state;
    canvas.add(canvas.state.bg);
    canvas.sendToBack(canvas.state.bg);
  }
  
  function handleUndo() {
    let canvas = fabRef.current;
    if (canvas.state.disableUndo) return;
    canvas.discardActiveObject(); // I don't want to think about this case

    let command = canvas.state.undoStack.pop()
    if (!command) return;

    switch (command.action) {
      case 'add':
        canvas.remove(...command.objects);
        break;
      case 'remove':
        canvas.add(...command.objects);
        break;
      case 'replace':
        canvas.remove(...command.newObjects);
        canvas.add(...command.oldObjects);
        break;
      case 'drag':
        command.objects.map((obj) => {
          obj.left -= command.dX;
          obj.top -= command.dY;
          obj.setCoords();
        });
        break;
      case 'rotate':
        command.objects.map((obj) => {
          let newCoords = fabric.util.rotatePoint(
            new fabric.Point(obj.left, obj.top), // point to rotate
            command.origin, // rotation origin
            fabric.util.degreesToRadians(-90), // angle
          );
          obj.set({left: newCoords.x, top: newCoords.y, angle: obj.get("angle") - 90})
          obj.setCoords();
        });
        break;
      default:
        console.log("Unexpected behavior in handleUndo()");
    }
    if (command.undoCallback) command.undoCallback();

    canvas.fire('saveState', {
      action: 'undo',
      undoneCommand: command,
    });
  }

  function handleRedo() {
    let canvas = fabRef.current;
    if (canvas.state.disableUndo) return;

    let command = canvas.state.redoStack.pop()
    if (!command) return;
    canvas.discardActiveObject();

    switch(command.action) {
      case 'add':
        canvas.add(...command.objects);
        break;
      case 'remove':
        canvas.remove(...command.objects);
        break;
      case 'replace':
        canvas.remove(...command.oldObjects);
        canvas.add(...command.newObjects);
        break;
      case 'drag':
        command.objects.map((obj) => {
          obj.left += command.dX;
          obj.top += command.dY;
          obj.setCoords();
        });
        break;
      case 'rotate':
        command.objects.map((obj) => {
          let newCoords = fabric.util.rotatePoint(
            new fabric.Point(obj.left, obj.top), // point to rotate
            command.origin, // rotation origin
            fabric.util.degreesToRadians(90), // angle
          );
          obj.set({left: newCoords.x, top: newCoords.y, angle: obj.get("angle") + 90})
          obj.setCoords();
        });
        break;
      default:
        console.log("Unexpected behavior in handleRedo()");
    }
    canvas.fire('saveState', {
      action: 'redo',
      redidCommand: command,
    })
  }

  let headerPropagate = {
    stateView,
    handlePrint, 
    handleImport, getExportJSON
  }

  let toolbarPropagate = {
    stateView,
    handleMode,
    handleDrawMode,
    handleSnap,
    handleRemoveMeta,
    handleCopy, handlePaste,
    handleDelete, handleRotate,
    handleUndo, handleRedo
  }

  return (
    <div>
      <Header {...headerPropagate}/>
      <canvas ref={canvasRef}> 
        Could not load canvas.
      </canvas>
      <Toolbar {...toolbarPropagate}/>
    </div>
  );
};

export default App