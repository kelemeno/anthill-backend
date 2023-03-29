import {address0,address1,  GraphData, DagVote, NodeDataStore, GraphDataDict, initialiseDagArray} from "./dagBase";


export function resetIntermediate(dag: GraphData) {
    const emptyDict = {} as GraphDataDict;

    dag.rootId = address0
    dag.maxRelRootDepth = 6
    dag.dict = emptyDict;
    var node1 = {"id":address1, "depth":-1, "relRoot":address1, "sentTreeVote": address1, "recTreeVotes":[], "recDagVotes":[], "sentDagVotes":[], "currentRep":0, "totalWeight":0, "name":"", "reputation":0};
    dag.dict[address1]  = node1;

}



async function getAnthillMaxRelRootDepth( AnthillContract: any,): Promise<number>{
    const res = await AnthillContract.methods.readMaxRelRootDepth().call();
    return res;
}


async function getAnthillRootId(dag: GraphData, AnthillContract: any,) :Promise<string>{
    const res = await AnthillContract.methods.readRoot().call();
    return res;
}

async function getAnthillName(AnthillContract: any, id: string):Promise<string> {
    const res = await AnthillContract.methods.readName(id).call();
    return res;
}

async function getAnthillReputation(AnthillContract: any, id: string):Promise<number> {
    const res = await AnthillContract.methods.readReputation(id).call();
    return parseInt(res);
}

async function getAnthillTotalWeight(AnthillContract: any, id: string):Promise<number> {
    const res = await AnthillContract.methods.readSentDagVoteTotalWeight(id).call();
    return parseInt(res);
}

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}



export async function getSentDagVotes(maxRelRootDepth:number,AnthillContract: any, id : string, timeout:number) : Promise<DagVote[][][]>{
    var dagVotes= initialiseDagArray(maxRelRootDepth); 
    var sentDagVoteCountString="" ;

    for (var dist =0; dist < maxRelRootDepth; dist++){
        for (var depth = 0; depth < maxRelRootDepth; depth++) {
            await delay(timeout);
            sentDagVoteCountString  = await AnthillContract.methods.readSentDagVoteCount(id, dist, depth).call();
            for (var j= 0; j < parseInt(sentDagVoteCountString); j++){
                await delay(timeout);
                var sDagVote = await AnthillContract.methods.readSentDagVote(id, dist, depth, j).call();
                if (sDagVote.id == address0){
                    continue;
                }
                dagVotes[dist][depth].push({"id":sDagVote.id , "weight":parseInt(sDagVote.weight), "posInOther":parseInt(sDagVote.posInOther)});
            
            }
        }
    }
    return dagVotes;
}

export async function getRecDagVotes(maxRelRootDepth:number, AnthillContract: any, id : string, timeout:number) : Promise<DagVote[][][]>{
    var dagVotes = initialiseDagArray(maxRelRootDepth);
    var recDagVoteCountString="" ;

    for (var dist = 0; dist < maxRelRootDepth; dist++) {
        for (var depth = 0; depth < maxRelRootDepth; depth++) {
            await delay(timeout);
            recDagVoteCountString  = await AnthillContract.methods.readRecDagVoteCount(id, dist, depth).call();
            for (var j= 0; j< parseInt(recDagVoteCountString); j++){
                await delay(timeout);
                var rDagVote = await AnthillContract.methods.readRecDagVote(id, dist, depth, j).call();
                if (rDagVote.id == address0){
                    continue;
                }
                // console.log("dagVotes", dagVotes, dist, depth, dagVotes[dist][depth]);
                dagVotes[dist][depth].push({"id":rDagVote.id , "weight":parseInt(rDagVote.weight), "posInOther":parseInt(rDagVote.posInOther)});
            }
        }
    }
    return dagVotes;
}

export async function getSaveChildren(dag: GraphData, AnthillContract: any, id: string, timeout:number){
    var childCount  = await AnthillContract.methods.readRecTreeVoteCount(id).call();
    for (var i = 0; i < childCount; i++) {
        var childId = (await AnthillContract.methods.readRecTreeVote(id, i).call());

        var sentDagVotes: DagVote[][][]= await getSentDagVotes(dag.maxRelRootDepth, AnthillContract, childId, timeout);
        var recDagVotes: DagVote[][][]= await getRecDagVotes(dag.maxRelRootDepth, AnthillContract, childId, timeout);
        var onChainRep = await getAnthillReputation(AnthillContract, childId);
        await delay(timeout);
        var name = await getAnthillName(AnthillContract, childId);
        await delay(timeout);
        var totalWeight = await getAnthillTotalWeight(AnthillContract, childId);

        var childNode = {"id": childId, "name":name,"totalWeight":totalWeight,  "currentRep": 0, "depth":0, "relRoot": "",  "sentTreeVote": id, "recTreeVotes": [], "sentDagVotes": sentDagVotes, "recDagVotes": recDagVotes} as NodeDataStore;
        dag.dict[childId] = childNode;

        // we push the children here instead of in the childnode initialisation above, as we are already crawling the tree. 
        dag.dict[id].recTreeVotes.push(childId);

        await getSaveChildren(dag, AnthillContract, childId, timeout);
    }
    
}

export async function loadAnthillGraph(dag: GraphData, depthA:string[][],  anthillGraphNum: number, AnthillContract: any,testing:boolean){
    var timeout=40;
    if (testing) {timeout = 0}; 

    resetIntermediate(dag);

    dag.maxRelRootDepth = await getAnthillMaxRelRootDepth( AnthillContract);
    
    anthillGraphNum +=1;

    var id : string= (await getAnthillRootId(dag, AnthillContract));
    dag.rootId = id;
    console.log("root is: " + id);
    var onChainRep = await getAnthillReputation(AnthillContract, id);
    var name = await getAnthillName(AnthillContract, id);
    var sentTreeVote = await AnthillContract.methods.readSentTreeVote(id).call();
    // the root has no sentDagVotes, so we don't read that.  
    var recDagVotes: DagVote[][][]= await getRecDagVotes(dag.maxRelRootDepth, AnthillContract, id, timeout);
    var totalWeight = await getAnthillTotalWeight(AnthillContract, id);

    var node = {"id": id, "name": name, "totalWeight":totalWeight, "currentRep": 0, "depth":0, "relRoot": "", "sentTreeVote": sentTreeVote ,  "recTreeVotes": [], "sentDagVotes": initialiseDagArray(dag.maxRelRootDepth) , "recDagVotes":recDagVotes} as NodeDataStore;
    dag.dict[id] = node;
    dag.dict[address1].recTreeVotes.push(id);

    await getSaveChildren(dag, AnthillContract, id, timeout);

}