const removedImageApi = new RegExp(
  `${["poster", "src"].join("-")}|${["poster", "Src"].join("")}`,
  "u"
);

const CONSUMER_ALTERNATE_REVEALS = Object.freeze([
  /\b(?<target>[A-Za-z_$][\w$]*)\.hidden\s*=\s*false\b/u,
  /\b(?<target>set(?:Failed|Failure|Fallback|Unavailable|Alternate))\s*\(\s*true\s*\)/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.removeAttribute\s*\(\s*["']hidden["']\s*\)/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.toggleAttribute\s*\(\s*["']hidden["']\s*,\s*false\s*\)/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.classList\.remove\s*\(\s*["'](?:hidden|is-hidden)["']\s*\)/u
]);

const CONSUMER_ALTERNATE_RECOVERIES = Object.freeze([
  /\b(?<target>[A-Za-z_$][\w$]*)\.hidden\s*=\s*true\b/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.hidden\s*=\s*[^;\n]{0,160}?readiness\s*===\s*["']interactiveReady["']/u,
  /\b(?<target>set(?:Failed|Failure|Fallback|Unavailable|Alternate))\s*\(\s*false\s*\)/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.setAttribute\s*\(\s*["']hidden["']/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.toggleAttribute\s*\(\s*["']hidden["']\s*,\s*true\s*\)/u,
  /\b(?<target>[A-Za-z_$][\w$]*)\.classList\.add\s*\(\s*["'](?:hidden|is-hidden)["']\s*\)/u
]);

const GENERIC_REVEAL_EFFECTS = Object.freeze([
  /\b(?:reveal|show)(?:Fallback|Alternate|Unavailable|Failure)?\s*\(/u
]);

export function hasRemovedImageApi(text) {
  return removedImageApi.test(text);
}

export function hasAvalFallbackSlot(text) {
  return [
    /\bslot\s*=\s*(?:["']fallback["']|fallback(?=[\s/>]))/iu,
    /\bslot\s*=\s*\{\s*["']fallback["']\s*\}/iu,
    /\bslot\s*:\s*["']fallback["']/iu,
    /\.setAttribute\s*\(\s*["']slot["']\s*,\s*["']fallback["']\s*\)/iu
  ].some((pattern) => pattern.test(text));
}

export function hasAvalHostSrc(text) {
  return /<aval-player(?=[\s/>])[^>]*\ssrc\s*=/isu.test(text);
}

export function hasUnfilteredAvalErrorHandler(text) {
  for (const registration of findEventListenerRegistrations(text, "error")) {
    const handler = resolveHandler(text, registration.handler);
    // An injected observer can intentionally record every error. Locally declared
    // and inline handlers are inspectable, so they must prove their fatal gate.
    if (handler !== null && !hasFatalGate(handler)) return true;
  }
  return false;
}

export function hasErrorListenerAfterDefinition(text) {
  const definition = /\bdefineAvalElement\s*\(/u.exec(text)?.index;
  if (definition === undefined) return false;
  return findEventListenerRegistrations(text, "error")
    .some((registration) => registration.index > definition);
}

export function hasMissingInteractiveRecovery(text) {
  const reveals = findConsumerAlternateActions(text, CONSUMER_ALTERNATE_REVEALS);
  if (reveals.length === 0) return false;
  const recoveries = findConsumerAlternateActions(
    text,
    CONSUMER_ALTERNATE_RECOVERIES
  );
  const firstListener = /\baddEventListener\s*\(/u.exec(text)?.index ?? text.length;
  for (const target of new Set(reveals.map((action) => action.target))) {
    const firstReveal = reveals.find((action) => action.target === target)?.index ?? text.length;
    let foundSafeRecovery = false;
    for (const recovery of recoveries) {
      if (recovery.target !== target) continue;
      // A consumer may initialize its alternate as hidden before wiring the
      // player. Every later hide is recovery behavior and must prove that the
      // player has reached interactive readiness.
      if (isInteractiveReadyGuarded(text, recovery)) {
        foundSafeRecovery = true;
        continue;
      }
      if (recovery.index < firstListener && recovery.index < firstReveal) continue;
      return true;
    }
    if (!foundSafeRecovery) return true;
  }
  return false;
}

export function hasStaticReadyInRenderedSet(text) {
  return /(?:RENDERED_READINESS|renderedReadiness)\s*=\s*new Set\s*\(\s*\[[\s\S]{0,320}?["']staticReady["']/u
    .test(text);
}

function findEventListenerRegistrations(text, eventName) {
  const escapedName = escapeRegExp(eventName);
  const pattern = new RegExp(
    `\\baddEventListener\\s*\\(\\s*["']${escapedName}["']\\s*,`,
    "gu"
  );
  const registrations = [];
  for (const match of text.matchAll(pattern)) {
    const handlerStart = (match.index ?? 0) + match[0].length;
    registrations.push({
      index: match.index ?? 0,
      handler: readExpression(text, handlerStart, new Set([",", ")"]))
    });
  }
  return registrations;
}

function resolveHandler(text, expression) {
  const trimmed = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/u.test(trimmed)) return trimmed;
  const name = escapeRegExp(trimmed);
  const functionDeclaration = new RegExp(
    `\\bfunction\\s+${name}\\s*\\(`,
    "gu"
  ).exec(text);
  if (functionDeclaration !== null) {
    const bodyStart = text.indexOf("{", functionDeclaration.index);
    if (bodyStart !== -1) return readBalanced(text, bodyStart, "{", "}").content;
  }
  const variableDeclaration = new RegExp(
    `\\b(?:const|let|var)\\s+${name}(?:\\s*:[^=;\\n]+)?\\s*=`,
    "gu"
  ).exec(text);
  if (variableDeclaration === null) return null;
  return readExpression(
    text,
    variableDeclaration.index + variableDeclaration[0].length,
    new Set([";"])
  );
}

function hasFatalGate(handler) {
  const statements = findIfStatements(handler);
  const hasGate = statements.some((statement) =>
    conditionAssertsFatal(statement.condition.content) ||
    conditionRejectsNonfatal(statement.condition.content) &&
      statementDefinitelyExits(statement.consequent)
  ) || /(?:\?\.|\.)\s*fatal\b[^;\n]{0,160}?&&/u.test(handler);
  if (!hasGate) return false;

  const effects = [
    ...findConsumerAlternateActions(handler, CONSUMER_ALTERNATE_REVEALS),
    ...findMatches(handler, GENERIC_REVEAL_EFFECTS)
  ];
  return effects.every((effect) => isFatalGuarded(handler, effect, statements));
}

function findIfStatements(text) {
  const statements = [];
  for (const match of text.matchAll(/\bif\s*\(/gu)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    const condition = readBalanced(text, open, "(", ")");
    statements.push({
      index: match.index ?? 0,
      condition,
      consequent: readStatement(text, condition.end)
    });
  }
  return statements;
}

function findConsumerAlternateActions(text, patterns) {
  return findMatches(text, patterns).map((match) => ({
    ...match,
    target: match.groups?.target ?? "*"
  }));
}

function findMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const value = match[0];
      const index = match.index ?? 0;
      matches.push({
        index,
        end: index + value.length,
        text: value,
        groups: match.groups
      });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index || left.end - right.end)
    .filter((match, index, all) =>
      index === 0 || match.index !== all[index - 1].index || match.end !== all[index - 1].end
    );
}

function isFatalGuarded(text, effect, statements) {
  for (const statement of statements) {
    if (
      conditionAssertsFatal(statement.condition.content) &&
      isInside(effect, statement.consequent)
    ) return true;
    if (
      conditionRejectsNonfatal(statement.condition.content) &&
      statementDefinitelyExits(statement.consequent) &&
      statement.consequent.end <= effect.index &&
      braceDepthAt(text, statement.index) === braceDepthAt(text, effect.index)
    ) return true;
  }
  const prefix = currentStatementPrefix(text, effect.index);
  return /(?:\?\.|\.)\s*fatal\b[^;\n]{0,160}?&&/u.test(prefix);
}

function isInteractiveReadyGuarded(text, recovery) {
  if (
    /\.hidden\s*=\s*[^;\n]{0,160}?readiness\s*===\s*["']interactiveReady["']/u
      .test(recovery.text)
  ) return true;
  for (const statement of findIfStatements(text)) {
    if (
      conditionAssertsInteractiveReady(statement.condition.content) &&
      isInside(recovery, statement.consequent)
    ) return true;
    if (
      conditionRejectsNonInteractive(statement.condition.content) &&
      statementDefinitelyExits(statement.consequent) &&
      statement.consequent.end <= recovery.index &&
      braceDepthAt(text, statement.index) === braceDepthAt(text, recovery.index)
    ) return true;
  }
  return /\breadiness\s*===\s*["']interactiveReady["'][^;\n]{0,160}?&&/u
    .test(currentStatementPrefix(text, recovery.index));
}

function conditionAssertsFatal(condition) {
  return /(?:\?\.|\.)\s*fatal\b/u.test(condition) &&
    !conditionRejectsNonfatal(condition);
}

function conditionRejectsNonfatal(condition) {
  return /!\s*(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)+fatal\b|(?:\?\.|\.)\s*fatal\s*!==?\s*true\b|(?:\?\.|\.)\s*fatal\s*===?\s*false\b/u
    .test(condition);
}

function conditionAssertsInteractiveReady(condition) {
  return /\breadiness\s*===?\s*["']interactiveReady["']/u.test(condition) &&
    !/\breadiness\s*!==?\s*["']interactiveReady["']/u.test(condition);
}

function conditionRejectsNonInteractive(condition) {
  return /\breadiness\s*!==?\s*["']interactiveReady["']/u.test(condition);
}

function statementDefinitelyExits(statement) {
  return /^(?:return|throw|continue)\b|^\{\s*(?:return|throw|continue)\b/u
    .test(statement.content.trimStart());
}

function isInside(action, statement) {
  return statement.start <= action.index && action.end <= statement.end;
}

function currentStatementPrefix(text, index) {
  const boundary = Math.max(
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("{", index - 1),
    text.lastIndexOf("}", index - 1),
    text.lastIndexOf("\n", index - 1)
  );
  return text.slice(boundary + 1, index);
}

function readStatement(text, start) {
  const statementStart = skipTrivia(text, start);
  if (text[statementStart] === "{") {
    const balanced = readBalanced(text, statementStart, "{", "}");
    return {
      start: statementStart,
      end: balanced.end,
      content: text.slice(statementStart, balanced.end)
    };
  }
  const end = scan(text, statementStart, new Set([";", "\n"]));
  const statementEnd = text[end] === ";" ? end + 1 : end;
  return {
    start: statementStart,
    end: statementEnd,
    content: text.slice(statementStart, statementEnd)
  };
}

function skipTrivia(text, start) {
  let index = start;
  for (;;) {
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (text.startsWith("//", index)) {
      index = text.indexOf("\n", index + 2);
      if (index === -1) return text.length;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      return end === -1 ? text.length : skipTrivia(text, end + 2);
    }
    return index;
  }
}

function braceDepthAt(text, end) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < end; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function readExpression(text, start, terminators) {
  const end = scan(text, start, terminators);
  return text.slice(start, end);
}

function readBalanced(text, open, opening, closing) {
  const end = scan(text, open + 1, new Set([closing]), [opening], true);
  return { content: text.slice(open + 1, end), end: end + 1 };
}

function scan(
  text,
  start,
  terminators,
  initialStack = [],
  stopWhenInitialDelimiterCloses = false
) {
  const stack = [...initialStack];
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (stack.length === 0) {
        if (terminators.has(character)) return index;
        continue;
      }
      stack.pop();
      if (
        stopWhenInitialDelimiterCloses &&
        stack.length === 0 &&
        terminators.has(character)
      ) return index;
      continue;
    }
    if (stack.length === 0 && terminators.has(character)) return index;
  }
  return text.length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
