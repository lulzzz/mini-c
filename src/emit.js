"use strict";

function getWasmType(type) {
  switch (type) {
    case TokenList.VOID: return (WASM_TYPE_CTOR_VOID);
    case TokenList.INT: case TokenList.INT32: return (WASM_TYPE_CTOR_I32);
    case TokenList.INT64: return (WASM_TYPE_CTOR_I64);
    case TokenList.FLOAT: case TokenList.FLOAT32: return (WASM_TYPE_CTOR_I32);
    case TokenList.FLOAT64: return (WASM_TYPE_CTOR_F64);
    case TokenList.BOOL: return (WASM_TYPE_CTOR_I32);
  };
  return (-1);
};

function getNativeTypeSize(type) {
  switch (type) {
    case TokenList.INT: case TokenList.INT32: return (4);
    case TokenList.INT64: return (8);
    case TokenList.FLOAT: case TokenList.FLOAT32: return (4);
    case TokenList.FLOAT64: return (8);
  };
  return (-1);
};

function getWasmOperator(op) {
  switch (op) {
    case "+": return (WASM_OPCODE_I32_ADD);
    case "-": return (WASM_OPCODE_I32_SUB);
    case "*": return (WASM_OPCODE_I32_MUL);
    case "/": return (WASM_OPCODE_I32_DIV_S);
    case "%": return (WASM_OPCODE_I32_REM_S);
    case "<": return (WASM_OPCODE_I32_LT_S);
    case "<=": return (WASM_OPCODE_I32_LE_S);
    case ">": return (WASM_OPCODE_I32_GT_S);
    case ">=": return (WASM_OPCODE_I32_GE_S);
    case "==": return (WASM_OPCODE_I32_EQ);
    case "!=": return (WASM_OPCODE_I32_NEQ);
    case "&&": return (WASM_OPCODE_I32_AND);
    case "||": return (WASM_OPCODE_I32_OR);
  };
  return (-1);
};

/**
 * 1. Type section -> function signatures
 * 2. Func section -> function indices
 * 3. Code section -> function bodys
 */
function emit(node) {
  scope = node.context;
  bytes.emitU32(WASM_MAGIC);
  bytes.emitU32(WASM_VERSION);
  emitTypeSection(node.body);
  emitFunctionSection(node.body);
  emitMemorySection(node);
  emitGlobalSection(node.body);
  emitExportSection(node.body);
  emitCodeSection(node.body);
};

function emitGlobalSection(node) {
  bytes.emitU8(WASM_SECTION_GLOBAL);
  let size = bytes.createU32vPatch();
  let count = bytes.createU32vPatch();
  let amount = 0;
  node.body.map((child) => {
    if (child.kind === Nodes.VariableDeclaration && child.isGlobal) {
      let init = child.init.right;
      // global have their own indices, patch it here
      child.index = amount++;
      bytes.emitU8(getWasmType(child.type));
      // mutability, enabled by default
      bytes.emitU8(1);
      emitNode(init);
      bytes.emitU8(WASM_OPCODE_END);
    }
  });
  count.patch(amount);
  size.patch(bytes.length - size.offset);
};

function emitTypeSection(node) {
  bytes.emitU8(WASM_SECTION_TYPE);
  let size = bytes.createU32vPatch();
  let count = bytes.createU32vPatch();
  let amount = 0;
  node.body.map((child) => {
    if (child.kind === Nodes.FunctionDeclaration) {
      bytes.emitU8(WASM_TYPE_CTOR_FUNC);
      // parameter count
      bytes.writeVarUnsigned(child.parameter.length);
      // parameter types
      child.parameter.map((param) => {
        bytes.emitU8(getWasmType(param.type));
      });
      // emit type
      if (child.type !== TokenList.VOID) {
        // return count
        bytes.emitU8(1);
        // return type
        bytes.emitU8(getWasmType(child.type));
      // void
      } else {
        bytes.emitU8(0);
      }
      amount++;
    }
  });
  count.patch(amount);
  // emit section size at reserved patch offset
  size.patch(bytes.length - size.offset);
};

function emitFunctionSection(node) {
  bytes.emitU8(WASM_SECTION_FUNCTION);
  let size = bytes.createU32vPatch();
  let count = bytes.createU32vPatch();
  let amount = 0;
  node.body.map((child) => {
    if (child.kind === Nodes.FunctionDeclaration) {
      amount++;
      bytes.writeVarUnsigned(child.index);
    }
  });
  count.patch(amount);
  size.patch(bytes.length - size.offset);
};

function emitMemorySection(node) {
  bytes.emitU8(WASM_SECTION_MEMORY);
  // we dont use memory yet, write empty bytes
  let size = bytes.createU32vPatch();
  bytes.emitU32v(1);
  bytes.emitU32v(0);
  bytes.emitU32v(1);
  size.patch(bytes.length - size.offset);
};

function emitExportSection(node) {
  bytes.emitU8(WASM_SECTION_EXPORT);
  let size = bytes.createU32vPatch();
  let count = bytes.createU32vPatch();
  let amount = 0;
  node.body.map((child) => {
    if (child.kind === Nodes.FunctionDeclaration) {
      if (child.isExported || child.id === "main") {
        amount++;
        bytes.emitString(child.id);
        bytes.emitU8(WASM_EXTERN_FUNCTION);
        bytes.writeVarUnsigned(child.index);
      }
    }
  });
  // export memory
  (() => {
    amount++;
    bytes.emitString("memory");
    bytes.emitU8(WASM_EXTERN_MEMORY);
    bytes.emitU8(0);
  })();
  count.patch(amount);
  size.patch(bytes.length - size.offset);
};

function emitCodeSection(node) {
  bytes.emitU8(WASM_SECTION_CODE);
  let size = bytes.createU32vPatch();
  let count = bytes.createU32vPatch();
  let amount = 0;
  node.body.map((child) => {
    if (child.kind === Nodes.FunctionDeclaration) {
      emitFunction(child);
      amount++;
    }
  });
  count.patch(amount);
  size.patch(bytes.length - size.offset);
};

let currentHeapOffset = 0;
function growHeap(amount) {
  currentHeapOffset += amount;
};

function emitNode(node) {
  let kind = node.kind;
  if (kind === Nodes.BlockStatement) {
    let actual = node.context.node;
    // if, while auto provide a block scope
    let skip = (
      actual.kind === Nodes.IfStatement ||
      actual.kind === Nodes.WhileStatement ||
      actual.kind === Nodes.FunctionDeclaration
    );
    if (skip) {
      //console.log("Skipping block code for", Nodes[actual.kind]);
    }
    if (node.context) {
      scope = node.context;
    }
    if (!skip) {
      bytes.emitU8(WASM_OPCODE_BLOCK);
      bytes.emitU8(WASM_TYPE_CTOR_BLOCK);
    }
    node.body.map((child) => {
      emitNode(child);
    });
    if (!skip) {
      bytes.emitU8(WASM_OPCODE_END);
    }
    if (node.context) {
      scope = scope.parent;
    }
  }
  else if (kind === Nodes.IfStatement) {
    if (node.condition) {
      emitNode(node.condition);
      bytes.emitU8(WASM_OPCODE_IF);
      bytes.emitU8(WASM_TYPE_CTOR_BLOCK);
    }
    emitNode(node.consequent);
    if (node.alternate) {
      bytes.emitU8(WASM_OPCODE_ELSE);
      emitNode(node.alternate);
    }
    if (node.condition) bytes.emitU8(WASM_OPCODE_END);
  }
  else if (kind === Nodes.ReturnStatement) {
    if (node.argument) emitNode(node.argument);
    bytes.emitU8(WASM_OPCODE_RETURN);
  }
  else if (kind === Nodes.CallExpression) {
    let callee = node.callee.value;
    let resolve = scope.resolve(callee);
    node.parameter.map((child) => {
      emitNode(child);
    });
    bytes.emitU8(WASM_OPCODE_CALL);
    bytes.writeVarUnsigned(resolve.index);
  }
  else if (kind === Nodes.VariableDeclaration) {
    emitVariableDeclaration(node);
  }
  else if (kind === Nodes.WhileStatement) {
    bytes.emitU8(WASM_OPCODE_BLOCK);
    bytes.emitU8(WASM_TYPE_CTOR_BLOCK);
    bytes.emitU8(WASM_OPCODE_LOOP);
    bytes.emitU8(WASM_TYPE_CTOR_BLOCK);
    // condition
    emitNode(node.condition);
    // break if condition != true
    bytes.emitU8(WASM_OPCODE_I32_EQZ);
    bytes.emitU8(WASM_OPCODE_BR_IF);
    bytes.emitU8(1);
    emitNode(node.body);
    // jump back to top
    bytes.emitU8(WASM_OPCODE_BR);
    bytes.emitU8(0);
    bytes.emitU8(WASM_OPCODE_UNREACHABLE);
    bytes.emitU8(WASM_OPCODE_END);
    bytes.emitU8(WASM_OPCODE_END);
  }
  else if (kind === Nodes.BreakStatement) {
    bytes.emitU8(WASM_OPCODE_BR);
    let label = getLoopDepthIndex();
    bytes.writeVarUnsigned(label);
    bytes.emitU8(WASM_OPCODE_UNREACHABLE);
  }
  else if (kind === Nodes.ContinueStatement) {
    bytes.emitU8(WASM_OPCODE_BR);
    let label = getLoopDepthIndex();
    bytes.writeVarUnsigned(label - 1);
    bytes.emitU8(WASM_OPCODE_UNREACHABLE);
  }
  else if (kind === Nodes.Literal) {
    if (node.type === Token.Identifier) {
      emitIdentifier(node);
    }
    else if (node.type === Token.NumericLiteral || node.type === Token.HexadecimalLiteral) {
      bytes.emitU8(WASM_OPCODE_I32_CONST);
      bytes.emitLEB128(parseInt(node.value));
    }
    else {
      __imports.error("Unknown literal type " + node.type);
    }
  }
  else if (kind === Nodes.UnaryPrefixExpression) {
    let operator = node.operator;
    // 0 - x
    if (operator === "-") {
      bytes.emitUi32(0);
      emitNode(node.value);
      bytes.emitU8(WASM_OPCODE_I32_SUB);
    }
    // ignored
    else if (operator === "+") {
      emitNode(node.value);
    }
    // x = 0
    else if (operator === "!") {
      emitNode(node.value);
      bytes.emitU8(WASM_OPCODE_I32_EQZ);
    }
    else if (operator === "++" || operator === "--") {
      let local = node.value;
      let resolve = scope.resolve(local.value);
      let op = (
        node.operator === "++" ? WASM_OPCODE_I32_ADD : WASM_OPCODE_I32_SUB
      );
      bytes.emitUi32(resolve.offset);
      emitNode(local);
      bytes.emitUi32(1);
      bytes.emitU8(op);
      // store it
      bytes.emitU8(WASM_OPCODE_I32_STORE);
      bytes.emitU8(2); // i32
      bytes.emitU8(0);
      bytes.emitUi32(resolve.offset);
      // tee_local with load
      bytes.emitU8(WASM_OPCODE_I32_LOAD);
      bytes.emitU8(2); // i32
      bytes.writeVarUnsigned(0);
    }
    else if (operator === "&") {
      emitReference(node);
    }
    else if (operator === "*") {
      emitDereference(node);
    }
  }
  else if (kind === Nodes.UnaryPostfixExpression) {
    emitPostfixExpression(node);
  }
  else if (kind === Nodes.BinaryExpression) {
    let operator = node.operator;
    if (operator === "=") {
      emitAssignment(node);
    } else {
      emitNode(node.left);
      emitNode(node.right);
      bytes.emitU8(getWasmOperator(operator));
    }
  }
  else {
    __imports.error("Unknown node kind " + kind);
  }
};

function emitReference(node) {
  let lvalue = node.value;
  let resolve = scope.resolve(lvalue.value);
  bytes.emitUi32(resolve.offset);
};

function emitDereference(node) {
  emitNode(node.value);
  bytes.emitU8(WASM_OPCODE_I32_LOAD);
  bytes.emitU8(2); // i32
  bytes.writeVarUnsigned(0);
};

function emitAssignment(node) {
  let target = node.left;
  // assignment to pointer
  if (node.left.operator === "*") {
    emitNode(node.left.value);
    // push the adress to assign
    emitNode(node.right);
    // store it
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
    return;
  }
  let resolve = scope.resolve(node.left.value);
  // deep assignment
  if (node.right.operator === "=") {
    emitNode(node.right);
    emitNode(node.right.left);
  }
  // reference variable
  else if (!insideVariableDeclaration && resolve.isReference && !resolve.isParameter) {
    emitNode(node.left);
    // push the adress to assign
    emitNode(node.right);
    // store it
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
  }
  // global variable
  else if (resolve.isGlobal) {
    emitNode(node.right);
    bytes.emitU8(WASM_OPCODE_SET_GLOBAL);
    bytes.writeVarUnsigned(resolve.index);
  }
  // default parameter kind
  else if (resolve.isParameter && !resolve.isReference) {
    emitNode(node.right);
    bytes.emitU8(WASM_OPCODE_SET_LOCAL);
    bytes.writeVarUnsigned(resolve.index);
  }
  // just a default variable assignment
  else {
    if (insideVariableDeclaration) {
      emitNode(node.right);
    } else {
      bytes.emitUi32(resolve.offset);
      emitNode(node.right);
      bytes.emitU8(WASM_OPCODE_I32_STORE);
      bytes.emitU8(2); // i32
      bytes.writeVarUnsigned(0);
    }
  }
};

function emitIdentifier(node) {
  let resolve = scope.resolve(node.value);
  if (resolve.isReference && resolve.isParameter) {
    bytes.emitU8(WASM_OPCODE_GET_LOCAL);
    bytes.writeVarUnsigned(resolve.index);
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
  }
  // global variable
  else if (resolve.isGlobal) {
    bytes.emitU8(WASM_OPCODE_GET_GLOBAL);
    bytes.writeVarUnsigned(resolve.index);
  }
  // handle pointer parameter
  else if (resolve.isParameter) {
    bytes.emitU8(WASM_OPCODE_GET_LOCAL);
    bytes.writeVarUnsigned(resolve.index);
  }
  // reference variable
  else if (resolve.isReference && !resolve.isParameter) {
    bytes.emitUi32(resolve.offset);
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
  }
  // pointer variable
  // push the pointers pointed to adress
  else if (resolve.isPointer) {
    // push the pointer's address
    bytes.emitUi32(resolve.offset);
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
  }
  // default variable
  else {
    bytes.emitUi32(resolve.offset);
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
  }
};

let insideVariableDeclaration = false;
function emitVariableDeclaration(node) {
  let resolve = scope.resolve(node.id);
  let storeInMemory = resolve.isMemoryLocated;
  node.offset = currentHeapOffset;
  // store pointer
  // +0 = pointer address, +4 = address pointed to
  if (resolve.isPointer || resolve.isReference) {
    __imports.log("Store pointer variable", node.id, "in memory at", resolve.offset);
    // # store the pointed adress
    // offset
    bytes.emitUi32(resolve.offset);
    growHeap(4);
    // value
    insideVariableDeclaration = true;
    emitNode(node.init);
    insideVariableDeclaration = false;
    // store
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
  }
  // store variable
  else {
    __imports.log("Store variable", node.id, "in memory at", resolve.offset);
    // offset
    bytes.emitUi32(resolve.offset);
    growHeap(4);
    // value
    insideVariableDeclaration = true;
    emitNode(node.init);
    insideVariableDeclaration = false;
    // store
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
  }
};

function getLoopDepthIndex() {
  let ctx = scope;
  let label = 0;
  while (ctx !== null) {
    label++;
    if (ctx.node.kind === Nodes.WhileStatement) break;
    ctx = ctx.parent;
  };
  return (label);
};

function emitPostfixExpression(node) {
  let local = node.value;
  let resolve = scope.resolve(local.value);
  if (node.operator === "++") {
    // store offset
    bytes.emitUi32(resolve.offset);
    // value to store
    bytes.emitUi32(1);
    emitIdentifier(local);
    bytes.emitU8(WASM_OPCODE_I32_ADD);
    // pop store
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
    bytes.emitUi32(resolve.offset);
    // tee_local with load
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
    bytes.emitUi32(1);
    bytes.emitU8(WASM_OPCODE_I32_SUB);
  } else if (node.operator === "--") {
    // store offset
    bytes.emitUi32(resolve.offset);
    emitIdentifier(local);
    bytes.emitUi32(1);
    bytes.emitU8(WASM_OPCODE_I32_SUB);
    // pop store
    bytes.emitU8(WASM_OPCODE_I32_STORE);
    bytes.emitU8(2); // i32
    bytes.emitU8(0);
    bytes.emitUi32(resolve.offset);
    // tee_local with load
    bytes.emitU8(WASM_OPCODE_I32_LOAD);
    bytes.emitU8(2); // i32
    bytes.writeVarUnsigned(0);
    bytes.emitUi32(1);
    bytes.emitU8(WASM_OPCODE_I32_ADD);
  }
};

function emitFunction(node) {
  let size = bytes.createU32vPatch();
  // emit count of locals
  let locals = node.locals;
  // local count
  bytes.writeVarUnsigned(locals.length);
  // local entry signatures
  locals.map((local) => {
    bytes.emitU8(1);
    bytes.emitU8(getWasmType(local.type));
  });
  emitNode(node.body);
  // patch function body size
  bytes.emitU8(WASM_OPCODE_END);
  size.patch(bytes.length - size.offset);
};

function getLocalSignatureUniforms(locals) {
  let uniforms = [];
  return (uniforms);
};

function getFunctionSignatureUniforms(fns) {
  let uniforms = [];
  return (uniforms);
};
