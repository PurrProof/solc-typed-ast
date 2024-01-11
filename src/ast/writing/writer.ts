import { strByteLen } from "../../misc";
import { ASTNode, ASTNodeConstructor } from "../ast_node";
import { YulNode } from "../implementation/statement/inline_assembly";
import { SourceFormatter } from "./formatter";

export interface YulNodeWriter {
    write(node: YulNode, writer: YulWriter): string;
}

export type SrcRangeMap = Map<ASTNode, [number, number]>;
export type DescArgs = Array<string | ASTNode | undefined | null>;

/**
 * The `SrcDesc` is the intermediate description for source that is generated by
 * `ASTNodeWriter`s. It has a tree-like structure, defined by the following grammar:
 *
 * ```
 * SrcDesc ::= (string | [ASTNode, SrcDesc])*
 * ```
 *
 * Essentially its a tree of strings, with some ASTNode attached to it at given locations.
 *
 * For example having `[ASTNode#5, <SrcDescX>]` in the tree, indicates that
 * the source generated by `<SrcDescX>` corresponds precisely to `ASTNode#5`
 * in the source map.
 */
export type SrcDesc = Array<string | [ASTNode, any[]]>;

/**
 * Base class for all `ASTNodeWriter`s.
 * Child classes are responsible for generating a `SrcDesc` for every node.
 */
export abstract class ASTNodeWriter {
    /**
     * Generate a `SrcDesc` for a given node,
     * but without adding the node itself to the tree.
     */
    abstract writeInner(node: ASTNode, writer: ASTWriter): SrcDesc;

    /**
     * Add the node to the descrioption generated by `writeInner`,
     * any additional "wrappings" and return it.
     * Usually `writeWhole` is responsible for adding semicolons and documentation,
     * since these are not generally part of source mappings.
     *
     * For example given this source:
     *
     * ```
     * a = 1;
     * ```
     *
     * `ExpressionStatement.writeInner` would return the following desc:
     *
     * ```
     * [[Assignment#3, [[Identifier#1, ["a"]], " = ", [Literal#2, ["1"]] ]]]
     * ```
     *
     * Then `ExpressionStatement.writeWhole` would add in
     * the `ExpressionStatement` node and the semicolon to return:
     *
     * ```
     * [[ExpressionStatement#4, [[Assignment#3, [[Identifier#1, ["a"]], " = ", [Literal#2, ["1"]] ]]]], ";"]
     * ```
     */
    writeWhole(node: ASTNode, writer: ASTWriter): SrcDesc {
        return [[node, this.writeInner(node, writer)]];
    }
}

export class YulWriter {
    mapping: Map<string, YulNodeWriter>;
    formatter: SourceFormatter;

    constructor(mapping: Map<string, YulNodeWriter>, formatter: SourceFormatter) {
        this.mapping = mapping;
        this.formatter = formatter;
    }

    write(node: YulNode): string {
        const writer = this.mapping.get(node.nodeType);

        if (writer) {
            return writer.write(node, this);
        }

        const data = JSON.stringify(node, undefined, 4);

        throw new Error("Unable to find writer for Yul node: " + data);
    }
}

export class ASTWriter {
    mapping: Map<ASTNodeConstructor<ASTNode>, ASTNodeWriter>;
    formatter: SourceFormatter;
    targetCompilerVersion: string;

    constructor(
        mapping: Map<ASTNodeConstructor<ASTNode>, ASTNodeWriter>,
        formatter: SourceFormatter,
        targetCompilerVersion: string
    ) {
        this.mapping = mapping;
        this.formatter = formatter;
        this.targetCompilerVersion = targetCompilerVersion;
    }

    /**
     * Convert the source description `desc`
     * generated by the `ASTNodeWriter`s into a source string,
     * while also populating the given source map `sourceMap`.
     */
    descToSourceString(desc: SrcDesc, sourceMap: SrcRangeMap): string {
        let source = "";
        let size = 0;

        const helper = (current: SrcDesc): void => {
            for (const element of current) {
                if (typeof element === "string") {
                    source += element;
                    size += strByteLen(element);
                } else {
                    const [node, nodeDesc] = element;
                    const start = size;

                    helper(nodeDesc);

                    const length = size - start;
                    sourceMap.set(node, [start, length]);
                }
            }
        };

        helper(desc);

        return source;
    }

    /**
     * Generate `SrcDesc` for element of `DescArgs`.
     *
     * Used by `ASTNodeWriter`s to handle different nested nodes.
     */
    desc(...args: DescArgs): SrcDesc {
        const result: SrcDesc = [];

        for (const arg of args) {
            if (arg === null || arg === undefined) {
                /**
                 * Intentionally skip
                 */
            } else if (typeof arg === "string") {
                result.push(arg);
            } else {
                const writer = this.mapping.get(arg.constructor as ASTNodeConstructor<ASTNode>);

                if (writer === undefined) {
                    if (arg instanceof ASTNode) {
                        throw new Error("Unable to find writer for AST arg: " + arg.print());
                    }

                    const data = JSON.stringify(arg, undefined, 4);

                    throw new Error("Expected an instance of ASTNode but got following: " + data);
                }

                result.push(...writer.writeWhole(arg, this));
            }
        }

        return result;
    }

    /**
     * Write out the given `node` to a string.
     *
     * If given a source map `sourceMap`, add a mapping from every child of `node`
     * to its corrseponding range in the resulting string in `sourceMap`.
     */
    write(node: ASTNode, sourceMap: SrcRangeMap = new Map<ASTNode, [number, number]>()): string {
        const desc = this.desc(node);

        return this.descToSourceString(desc, sourceMap);
    }
}
