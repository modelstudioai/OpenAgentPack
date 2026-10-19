'use strict';

// A parsed leaf adds one child edge below the innermost brace/parenthesis.
const MAX_NESTING = 128;
const MAX_AST_DEPTH = MAX_NESTING + 1;
const MAX_AST_VISITS = 65536;

exports.assertNesting = depth => {
  if (depth > MAX_NESTING) {
    throw new SyntaxError(`Brace nesting exceeds safe depth of ${MAX_NESTING}`);
  }
};

// Only child edges are traversed. Parser parent/prev backlinks are intentional.
// Active-path tracking allows shared acyclic nodes; the visit budget also bounds
// DAGs whose repeated subtrees would otherwise take exponential time to walk.
exports.assertTree = ast => {
  const pending = [{ node: ast, depth: 0, childIndex: 0, entered: false }];
  const ancestors = new WeakSet();
  let visits = 0;

  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    const node = frame.node;

    if (!frame.entered) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new SyntaxError('Brace AST nodes must be objects');
      }
      if (frame.depth > MAX_AST_DEPTH || ++visits > MAX_AST_VISITS) {
        throw new SyntaxError('Brace AST exceeds safe traversal limits');
      }
      if (ancestors.has(node)) {
        throw new SyntaxError('Brace AST must not contain child cycles');
      }
      if (node.nodes !== undefined && !Array.isArray(node.nodes)) {
        throw new SyntaxError('Brace AST children must be an array');
      }
      if (node.value !== undefined && typeof node.value !== 'string') {
        throw new SyntaxError('Brace AST values must be strings');
      }
      ancestors.add(node);
      frame.entered = true;
    }

    if (node.nodes && frame.childIndex < node.nodes.length) {
      const child = node.nodes[frame.childIndex++];
      pending.push({ node: child, depth: frame.depth + 1, childIndex: 0, entered: false });
    } else {
      ancestors.delete(node);
      pending.pop();
    }
  }
};
