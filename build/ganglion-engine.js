/*! Chitin: a web browser that runs inside a web page. Copyright (c) 2026 [OWNER NAME].
 * Licensed under the GNU GPL, version 2 or later (LICENSE.md); built on Ladybird (BSD-2-Clause,
 * CREDITS.md). Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]). */
// Chitin segment glue (bundled by tools/bundle-glue.py; sources in glue/).
(function () {
'use strict';

// ===== glue/00-primordials.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin segment glue: captured primordials.
//
// Page JS shares this realm with the glue, so every builtin the glue relies on is captured here,
// before any page script runs, in the style of Node.js's lib/internal/per_context/primordials.js.
// After this point the glue never looks up a property the page could have replaced:
//   - methods are called through uncurried captured functions, never as obj.method();
//   - internal records, tables and lists are null-prototype objects or arrays, so reads and
//     writes never reach a prototype the page can define accessors on (Array.prototype[0] setters
//     would otherwise see every value the glue stores);
//   - typed-array views over linear memory are only indexed, never passed to anything that reads
//     .length, .buffer or .constructor (a patched %TypedArray%.prototype getter would receive the
//     view and could reach memory.buffer, i.e. the whole engine);
//   - glue code is strict mode, so V8's Error.prepareStackTrace CallSites cannot hand page JS a
//     glue function or receiver (getThis/getFunction return undefined in strict frames).

const {
    Array,
    ArrayBuffer: HostArrayBuffer,
    DOMException: HostDOMException,
    Error: HostError,
    FinalizationRegistry,
    Float32Array,
    Float64Array,
    Function: HostFunction,
    Math: HostMath,
    Number: HostNumber,
    Object: HostObject,
    Reflect: HostReflect,
    String: HostString,
    Symbol: HostSymbol,
    TextDecoder,
    TypeError: HostTypeError,
    Uint16Array,
    Uint32Array,
    WeakMap,
    WeakRef,
    WebAssembly: HostWebAssembly,
} = globalThis;

const uncurryThis = HostFunction.prototype.bind.bind(HostFunction.prototype.call);

const ReflectApply = HostReflect.apply;
const ReflectSet = HostReflect.set;
const ReflectConstruct = HostReflect.construct;
const ObjectDefineProperty = HostObject.defineProperty;
const ObjectGetOwnPropertyDescriptor = HostObject.getOwnPropertyDescriptor;
const ObjectSetPrototypeOf = HostObject.setPrototypeOf;
const ObjectGetPrototypeOf = HostObject.getPrototypeOf;
const ObjectFreeze = HostObject.freeze;
const ObjectKeys = HostObject.keys;
const HostDate = globalThis.Date;
const DatePrototypeGetTime = HostDate.prototype.getTime;
const ObjectHasOwn = HostObject.hasOwn;
const NumberIsFinite = HostNumber.isFinite;
const MathFloor = HostMath.floor;
const MathMin = HostMath.min;
const MathMax = HostMath.max;
const StringFromCharCode = HostString.fromCharCode;
const StringPrototypeCharCodeAt = uncurryThis(HostString.prototype.charCodeAt);
const StringPrototypeIncludes = uncurryThis(HostString.prototype.includes);
const StringPrototypeIndexOf = uncurryThis(HostString.prototype.indexOf);
const StringPrototypeTrim = uncurryThis(HostString.prototype.trim);
const MapPrototypeClear = uncurryThis(globalThis.Map.prototype.clear);
// The host's microtask queue: promise jobs run on it, and the page's queueMicrotask joins it (see 40-bridge.js).
const HostQueueMicrotask = typeof queueMicrotask === 'function' ? queueMicrotask : null;
// A host task that runs after the host's microtasks, unclamped (setTimeout nests to 4 ms): one MessageChannel of the host's.
const HostMessageChannel = typeof MessageChannel === 'function' && typeof MessagePort === 'function' ? MessageChannel : null;
// (Node's ports are own properties of the channel, Chrome's are accessors on the prototype.)
const channelPortGetter = (name) => {
    const d = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(HostMessageChannel.prototype, name) : undefined;
    return d && d.get ? uncurryThis(d.get) : (channel) => channel[name];
};
const MessageChannelPort1 = channelPortGetter('port1');
const MessageChannelPort2 = channelPortGetter('port2');
const MessagePortPostMessage = HostMessageChannel ? uncurryThis(globalThis.MessagePort.prototype.postMessage) : null;
const portOnmessage = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(MessagePort.prototype, 'onmessage') : undefined;
const MessagePortSetOnmessage = portOnmessage && portOnmessage.set ? uncurryThis(portOnmessage.set) : (port, f) => { port.onmessage = f; };
const SymbolUnscopables = HostSymbol.unscopables;
const SymbolToStringTag = HostSymbol.toStringTag;
const WeakRefPrototypeDeref = uncurryThis(WeakRef.prototype.deref);
const FinalizationRegistryPrototypeRegister = uncurryThis(FinalizationRegistry.prototype.register);
const WeakMapPrototypeGet = uncurryThis(WeakMap.prototype.get);
const WeakMapPrototypeSet = uncurryThis(WeakMap.prototype.set);
const TextDecoderPrototypeDecode = uncurryThis(TextDecoder.prototype.decode);
const WebAssemblyModule = HostWebAssembly.Module;
const WebAssemblyInstance = HostWebAssembly.Instance;
const WebAssemblyMemoryPrototypeGetBuffer = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Memory.prototype, 'buffer').get);
const WebAssemblyInstancePrototypeGetExports = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Instance.prototype, 'exports').get);
const indirectEval = globalThis.eval;
const hostReportError = typeof globalThis.reportError === 'function' ? globalThis.reportError : undefined;
const hostConsoleError = globalThis.console && globalThis.console.error ? uncurryThis(globalThis.console.error) : undefined;
const hostConsole = globalThis.console;
const hostPerformanceNow = globalThis.performance ? uncurryThis(globalThis.performance.now) : undefined;
const hostPerformance = globalThis.performance;

// A null-prototype array: indexed writes never consult Array.prototype.
function safeArray() {
    return ObjectSetPrototypeOf([], null);
}

function typeError(message) {
    return new HostTypeError(message);
}

// ===== build/gen/webcompat.gen.js =====
// The site-compatibility list (generated by tools/webcompat-gen.py from webcompat/*.json; docs/surface.md).
const SITE_COMPATIBILITY = [{"matches":["https://aljazeera.com/*","https://*.aljazeera.com/*"],"expose_experimental_interfaces":["Navigator.permissions","WorkerNavigator.permissions","PermissionStatus"]},{"matches":["https://cnn.com/*","https://*.cnn.com/*"],"user_agent":["hide_Chitin"]},{"matches":["https://www.nytimes.com/*"],"user_agent":["hide_Chitin"]}];

// ===== build/gen/psl.gen.js =====
// Generated by tools/psl-gen.py from third_party/psl/public_suffix_list.dat (Mozilla Public License 2.0,
// https://publicsuffix.org). Do not edit.
const PSL_RULES = 'ac\ncom.ac\nedu.ac\ngov.ac\nnet.ac\nmil.ac\norg.ac\nad\nnom.ad\nae\nco.ae\nnet.ae\norg.ae\nsch.ae\nac.ae\ngov.ae\nmil.ae\naero\naccident-investigation.aero\naccident-prevention.aero\naerobatic.aero\naeroclub.aero\naerodrome.aero\nagents.aero\naircraft.aero\nairline.aero\nairport.aero\nair-surveillance.aero\nairtraffic.aero\nair-traffic-control.aero\nambulance.aero\namusement.aero\nassociation.aero\nauthor.aero\nballooning.aero\nbroker.aero\ncaa.aero\ncargo.aero\ncatering.aero\ncertification.aero\nchampionship.aero\ncharter.aero\ncivilaviation.aero\nclub.aero\nconference.aero\nconsultant.aero\nconsulting.aero\ncontrol.aero\ncouncil.aero\ncrew.aero\ndesign.aero\ndgca.aero\neducator.aero\nemergency.aero\nengine.aero\nengineer.aero\nentertainment.aero\nequipment.aero\nexchange.aero\nexpress.aero\nfederation.aero\nflight.aero\nfuel.aero\ngliding.aero\ngovernment.aero\ngroundhandling.aero\ngroup.aero\nhanggliding.aero\nhomebuilt.aero\ninsurance.aero\njournal.aero\njournalist.aero\nleasing.aero\nlogistics.aero\nmagazine.aero\nmaintenance.aero\nmedia.aero\nmicrolight.aero\nmodelling.aero\nnavigation.aero\nparachuting.aero\nparagliding.aero\npassenger-association.aero\npilot.aero\npress.aero\nproduction.aero\nrecreation.aero\nrepbody.aero\nres.aero\nresearch.aero\nrotorcraft.aero\nsafety.aero\nscientist.aero\nservices.aero\nshow.aero\nskydiving.aero\nsoftware.aero\nstudent.aero\ntrader.aero\ntrading.aero\ntrainer.aero\nunion.aero\nworkinggroup.aero\nworks.aero\naf\ngov.af\ncom.af\norg.af\nnet.af\nedu.af\nag\ncom.ag\norg.ag\nnet.ag\nco.ag\nnom.ag\nai\noff.ai\ncom.ai\nnet.ai\norg.ai\nal\ncom.al\nedu.al\ngov.al\nmil.al\nnet.al\norg.al\nam\nco.am\ncom.am\ncommune.am\nnet.am\norg.am\nao\ned.ao\ngv.ao\nog.ao\nco.ao\npb.ao\nit.ao\naq\nar\nbet.ar\ncom.ar\ncoop.ar\nedu.ar\ngob.ar\ngov.ar\nint.ar\nmil.ar\nmusica.ar\nmutual.ar\nnet.ar\norg.ar\nsenasa.ar\ntur.ar\narpa\ne164.arpa\nin-addr.arpa\nip6.arpa\niris.arpa\nuri.arpa\nurn.arpa\nas\ngov.as\nasia\nat\nac.at\nco.at\ngv.at\nor.at\nsth.ac.at\nau\ncom.au\nnet.au\norg.au\nedu.au\ngov.au\nasn.au\nid.au\ninfo.au\nconf.au\noz.au\nact.au\nnsw.au\nnt.au\nqld.au\nsa.au\ntas.au\nvic.au\nwa.au\nact.edu.au\ncatholic.edu.au\nnsw.edu.au\nnt.edu.au\nqld.edu.au\nsa.edu.au\ntas.edu.au\nvic.edu.au\nwa.edu.au\nqld.gov.au\nsa.gov.au\ntas.gov.au\nvic.gov.au\nwa.gov.au\nschools.nsw.edu.au\naw\ncom.aw\nax\naz\ncom.az\nnet.az\nint.az\ngov.az\norg.az\nedu.az\ninfo.az\npp.az\nmil.az\nname.az\npro.az\nbiz.az\nba\ncom.ba\nedu.ba\ngov.ba\nmil.ba\nnet.ba\norg.ba\nbb\nbiz.bb\nco.bb\ncom.bb\nedu.bb\ngov.bb\ninfo.bb\nnet.bb\norg.bb\nstore.bb\ntv.bb\n*.bd\nbe\nac.be\nbf\ngov.bf\nbg\na.bg\nb.bg\nc.bg\nd.bg\ne.bg\nf.bg\ng.bg\nh.bg\ni.bg\nj.bg\nk.bg\nl.bg\nm.bg\nn.bg\no.bg\np.bg\nq.bg\nr.bg\ns.bg\nt.bg\nu.bg\nv.bg\nw.bg\nx.bg\ny.bg\nz.bg\n0.bg\n1.bg\n2.bg\n3.bg\n4.bg\n5.bg\n6.bg\n7.bg\n8.bg\n9.bg\nbh\ncom.bh\nedu.bh\nnet.bh\norg.bh\ngov.bh\nbi\nco.bi\ncom.bi\nedu.bi\nor.bi\norg.bi\nbiz\nbj\nafrica.bj\nagro.bj\narchitectes.bj\nassur.bj\navocats.bj\nco.bj\ncom.bj\neco.bj\necono.bj\nedu.bj\ninfo.bj\nloisirs.bj\nmoney.bj\nnet.bj\norg.bj\note.bj\nresto.bj\nrestaurant.bj\ntourism.bj\nuniv.bj\nbm\ncom.bm\nedu.bm\ngov.bm\nnet.bm\norg.bm\nbn\ncom.bn\nedu.bn\ngov.bn\nnet.bn\norg.bn\nbo\ncom.bo\nedu.bo\ngob.bo\nint.bo\norg.bo\nnet.bo\nmil.bo\ntv.bo\nweb.bo\nacademia.bo\nagro.bo\narte.bo\nblog.bo\nbolivia.bo\nciencia.bo\ncooperativa.bo\ndemocracia.bo\ndeporte.bo\necologia.bo\neconomia.bo\nempresa.bo\nindigena.bo\nindustria.bo\ninfo.bo\nmedicina.bo\nmovimiento.bo\nmusica.bo\nnatural.bo\nnombre.bo\nnoticias.bo\npatria.bo\npolitica.bo\nprofesional.bo\nplurinacional.bo\npueblo.bo\nrevista.bo\nsalud.bo\ntecnologia.bo\ntksat.bo\ntransporte.bo\nwiki.bo\nbr\n9guacu.br\nabc.br\nadm.br\nadv.br\nagr.br\naju.br\nam.br\nanani.br\naparecida.br\napp.br\narq.br\nart.br\nato.br\nb.br\nbarueri.br\nbelem.br\nbhz.br\nbib.br\nbio.br\nblog.br\nbmd.br\nboavista.br\nbsb.br\ncampinagrande.br\ncampinas.br\ncaxias.br\ncim.br\ncng.br\ncnt.br\ncom.br\ncontagem.br\ncoop.br\ncoz.br\ncri.br\ncuiaba.br\ncuritiba.br\ndef.br\ndes.br\ndet.br\ndev.br\necn.br\neco.br\nedu.br\nemp.br\nenf.br\neng.br\nesp.br\netc.br\neti.br\nfar.br\nfeira.br\nflog.br\nfloripa.br\nfm.br\nfnd.br\nfortal.br\nfot.br\nfoz.br\nfst.br\ng12.br\ngeo.br\nggf.br\ngoiania.br\ngov.br\nac.gov.br\nal.gov.br\nam.gov.br\nap.gov.br\nba.gov.br\nce.gov.br\ndf.gov.br\nes.gov.br\ngo.gov.br\nma.gov.br\nmg.gov.br\nms.gov.br\nmt.gov.br\npa.gov.br\npb.gov.br\npe.gov.br\npi.gov.br\npr.gov.br\nrj.gov.br\nrn.gov.br\nro.gov.br\nrr.gov.br\nrs.gov.br\nsc.gov.br\nse.gov.br\nsp.gov.br\nto.gov.br\ngru.br\nimb.br\nind.br\ninf.br\njab.br\njampa.br\njdf.br\njoinville.br\njor.br\njus.br\nleg.br\nlel.br\nlog.br\nlondrina.br\nmacapa.br\nmaceio.br\nmanaus.br\nmaringa.br\nmat.br\nmed.br\nmil.br\nmorena.br\nmp.br\nmus.br\nnatal.br\nnet.br\nniteroi.br\n*.nom.br\nnot.br\nntr.br\nodo.br\nong.br\norg.br\nosasco.br\npalmas.br\npoa.br\nppg.br\npro.br\npsc.br\npsi.br\npvh.br\nqsl.br\nradio.br\nrec.br\nrecife.br\nrep.br\nribeirao.br\nrio.br\nriobranco.br\nriopreto.br\nsalvador.br\nsampa.br\nsantamaria.br\nsantoandre.br\nsaobernardo.br\nsaogonca.br\nseg.br\nsjc.br\nslg.br\nslz.br\nsorocaba.br\nsrv.br\ntaxi.br\ntc.br\ntec.br\nteo.br\nthe.br\ntmp.br\ntrd.br\ntur.br\ntv.br\nudi.br\nvet.br\nvix.br\nvlog.br\nwiki.br\nzlg.br\nbs\ncom.bs\nnet.bs\norg.bs\nedu.bs\ngov.bs\nbt\ncom.bt\nedu.bt\ngov.bt\nnet.bt\norg.bt\nbv\nbw\nco.bw\norg.bw\nby\ngov.by\nmil.by\ncom.by\nof.by\nbz\ncom.bz\nnet.bz\norg.bz\nedu.bz\ngov.bz\nca\nab.ca\nbc.ca\nmb.ca\nnb.ca\nnf.ca\nnl.ca\nns.ca\nnt.ca\nnu.ca\non.ca\npe.ca\nqc.ca\nsk.ca\nyk.ca\ngc.ca\ncat\ncc\ncd\ngov.cd\ncf\ncg\nch\nci\norg.ci\nor.ci\ncom.ci\nco.ci\nedu.ci\ned.ci\nac.ci\nnet.ci\ngo.ci\nasso.ci\nxn--aroport-bya.ci\nint.ci\npresse.ci\nmd.ci\ngouv.ci\n*.ck\n!www.ck\ncl\nco.cl\ngob.cl\ngov.cl\nmil.cl\ncm\nco.cm\ncom.cm\ngov.cm\nnet.cm\ncn\nac.cn\ncom.cn\nedu.cn\ngov.cn\nnet.cn\norg.cn\nmil.cn\nxn--55qx5d.cn\nxn--io0a7i.cn\nxn--od0alg.cn\nah.cn\nbj.cn\ncq.cn\nfj.cn\ngd.cn\ngs.cn\ngz.cn\ngx.cn\nha.cn\nhb.cn\nhe.cn\nhi.cn\nhl.cn\nhn.cn\njl.cn\njs.cn\njx.cn\nln.cn\nnm.cn\nnx.cn\nqh.cn\nsc.cn\nsd.cn\nsh.cn\nsn.cn\nsx.cn\ntj.cn\nxj.cn\nxz.cn\nyn.cn\nzj.cn\nhk.cn\nmo.cn\ntw.cn\nco\narts.co\ncom.co\nedu.co\nfirm.co\ngov.co\ninfo.co\nint.co\nmil.co\nnet.co\nnom.co\norg.co\nrec.co\nweb.co\ncom\ncoop\ncr\nac.cr\nco.cr\ned.cr\nfi.cr\ngo.cr\nor.cr\nsa.cr\ncu\ncom.cu\nedu.cu\norg.cu\nnet.cu\ngov.cu\ninf.cu\ncv\ncom.cv\nedu.cv\nint.cv\nnome.cv\norg.cv\ncw\ncom.cw\nedu.cw\nnet.cw\norg.cw\ncx\ngov.cx\ncy\nac.cy\nbiz.cy\ncom.cy\nekloges.cy\ngov.cy\nltd.cy\nmil.cy\nnet.cy\norg.cy\npress.cy\npro.cy\ntm.cy\ncz\nde\ndj\ndk\ndm\ncom.dm\nnet.dm\norg.dm\nedu.dm\ngov.dm\ndo\nart.do\ncom.do\nedu.do\ngob.do\ngov.do\nmil.do\nnet.do\norg.do\nsld.do\nweb.do\ndz\nart.dz\nasso.dz\ncom.dz\nedu.dz\ngov.dz\norg.dz\nnet.dz\npol.dz\nsoc.dz\ntm.dz\nec\ncom.ec\ninfo.ec\nnet.ec\nfin.ec\nk12.ec\nmed.ec\npro.ec\norg.ec\nedu.ec\ngov.ec\ngob.ec\nmil.ec\nedu\nee\nedu.ee\ngov.ee\nriik.ee\nlib.ee\nmed.ee\ncom.ee\npri.ee\naip.ee\norg.ee\nfie.ee\neg\ncom.eg\nedu.eg\neun.eg\ngov.eg\nmil.eg\nname.eg\nnet.eg\norg.eg\nsci.eg\n*.er\nes\ncom.es\nnom.es\norg.es\ngob.es\nedu.es\net\ncom.et\ngov.et\norg.et\nedu.et\nbiz.et\nname.et\ninfo.et\nnet.et\neu\nfi\naland.fi\nfj\nac.fj\nbiz.fj\ncom.fj\ngov.fj\ninfo.fj\nmil.fj\nname.fj\nnet.fj\norg.fj\npro.fj\n*.fk\ncom.fm\nedu.fm\nnet.fm\norg.fm\nfm\nfo\nfr\nasso.fr\ncom.fr\ngouv.fr\nnom.fr\nprd.fr\ntm.fr\navoues.fr\ncci.fr\ngreta.fr\nhuissier-justice.fr\nga\ngb\nedu.gd\ngov.gd\ngd\nge\ncom.ge\nedu.ge\ngov.ge\norg.ge\nmil.ge\nnet.ge\npvt.ge\ngf\ngg\nco.gg\nnet.gg\norg.gg\ngh\ncom.gh\nedu.gh\ngov.gh\norg.gh\nmil.gh\ngi\ncom.gi\nltd.gi\ngov.gi\nmod.gi\nedu.gi\norg.gi\ngl\nco.gl\ncom.gl\nedu.gl\nnet.gl\norg.gl\ngm\ngn\nac.gn\ncom.gn\nedu.gn\ngov.gn\norg.gn\nnet.gn\ngov\ngp\ncom.gp\nnet.gp\nmobi.gp\nedu.gp\norg.gp\nasso.gp\ngq\ngr\ncom.gr\nedu.gr\nnet.gr\norg.gr\ngov.gr\ngs\ngt\ncom.gt\nedu.gt\ngob.gt\nind.gt\nmil.gt\nnet.gt\norg.gt\ngu\ncom.gu\nedu.gu\ngov.gu\nguam.gu\ninfo.gu\nnet.gu\norg.gu\nweb.gu\ngw\ngy\nco.gy\ncom.gy\nedu.gy\ngov.gy\nnet.gy\norg.gy\nhk\ncom.hk\nedu.hk\ngov.hk\nidv.hk\nnet.hk\norg.hk\nxn--55qx5d.hk\nxn--wcvs22d.hk\nxn--lcvr32d.hk\nxn--mxtq1m.hk\nxn--gmqw5a.hk\nxn--ciqpn.hk\nxn--gmq050i.hk\nxn--zf0avx.hk\nxn--io0a7i.hk\nxn--mk0axi.hk\nxn--od0alg.hk\nxn--od0aq3b.hk\nxn--tn0ag.hk\nxn--uc0atv.hk\nxn--uc0ay4a.hk\nhm\nhn\ncom.hn\nedu.hn\norg.hn\nnet.hn\nmil.hn\ngob.hn\nhr\niz.hr\nfrom.hr\nname.hr\ncom.hr\nht\ncom.ht\nshop.ht\nfirm.ht\ninfo.ht\nadult.ht\nnet.ht\npro.ht\norg.ht\nmed.ht\nart.ht\ncoop.ht\npol.ht\nasso.ht\nedu.ht\nrel.ht\ngouv.ht\nperso.ht\nhu\nco.hu\ninfo.hu\norg.hu\npriv.hu\nsport.hu\ntm.hu\n2000.hu\nagrar.hu\nbolt.hu\ncasino.hu\ncity.hu\nerotica.hu\nerotika.hu\nfilm.hu\nforum.hu\ngames.hu\nhotel.hu\ningatlan.hu\njogasz.hu\nkonyvelo.hu\nlakas.hu\nmedia.hu\nnews.hu\nreklam.hu\nsex.hu\nshop.hu\nsuli.hu\nszex.hu\ntozsde.hu\nutazas.hu\nvideo.hu\nid\nac.id\nbiz.id\nco.id\ndesa.id\ngo.id\nmil.id\nmy.id\nnet.id\nor.id\nponpes.id\nsch.id\nweb.id\nie\ngov.ie\nil\nac.il\nco.il\ngov.il\nidf.il\nk12.il\nmuni.il\nnet.il\norg.il\nxn--4dbrk0ce\nxn--4dbgdty6c.xn--4dbrk0ce\nxn--5dbhl8d.xn--4dbrk0ce\nxn--8dbq2a.xn--4dbrk0ce\nxn--hebda8b.xn--4dbrk0ce\nim\nac.im\nco.im\ncom.im\nltd.co.im\nnet.im\norg.im\nplc.co.im\ntt.im\ntv.im\nin\n5g.in\n6g.in\nac.in\nai.in\nam.in\nbihar.in\nbiz.in\nbusiness.in\nca.in\ncn.in\nco.in\ncom.in\ncoop.in\ncs.in\ndelhi.in\ndr.in\nedu.in\ner.in\nfirm.in\ngen.in\ngov.in\ngujarat.in\nind.in\ninfo.in\nint.in\ninternet.in\nio.in\nme.in\nmil.in\nnet.in\nnic.in\norg.in\npg.in\npost.in\npro.in\nres.in\ntravel.in\ntv.in\nuk.in\nup.in\nus.in\ninfo\nint\neu.int\nio\ncom.io\niq\ngov.iq\nedu.iq\nmil.iq\ncom.iq\norg.iq\nnet.iq\nir\nac.ir\nco.ir\ngov.ir\nid.ir\nnet.ir\norg.ir\nsch.ir\nxn--mgba3a4f16a.ir\nxn--mgba3a4fra.ir\nis\nnet.is\ncom.is\nedu.is\ngov.is\norg.is\nint.is\nit\ngov.it\nedu.it\nabr.it\nabruzzo.it\naosta-valley.it\naostavalley.it\nbas.it\nbasilicata.it\ncal.it\ncalabria.it\ncam.it\ncampania.it\nemilia-romagna.it\nemiliaromagna.it\nemr.it\nfriuli-v-giulia.it\nfriuli-ve-giulia.it\nfriuli-vegiulia.it\nfriuli-venezia-giulia.it\nfriuli-veneziagiulia.it\nfriuli-vgiulia.it\nfriuliv-giulia.it\nfriulive-giulia.it\nfriulivegiulia.it\nfriulivenezia-giulia.it\nfriuliveneziagiulia.it\nfriulivgiulia.it\nfvg.it\nlaz.it\nlazio.it\nlig.it\nliguria.it\nlom.it\nlombardia.it\nlombardy.it\nlucania.it\nmar.it\nmarche.it\nmol.it\nmolise.it\npiedmont.it\npiemonte.it\npmn.it\npug.it\npuglia.it\nsar.it\nsardegna.it\nsardinia.it\nsic.it\nsicilia.it\nsicily.it\ntaa.it\ntos.it\ntoscana.it\ntrentin-sud-tirol.it\nxn--trentin-sd-tirol-rzb.it\ntrentin-sudtirol.it\nxn--trentin-sdtirol-7vb.it\ntrentin-sued-tirol.it\ntrentin-suedtirol.it\ntrentino-a-adige.it\ntrentino-aadige.it\ntrentino-alto-adige.it\ntrentino-altoadige.it\ntrentino-s-tirol.it\ntrentino-stirol.it\ntrentino-sud-tirol.it\nxn--trentino-sd-tirol-c3b.it\ntrentino-sudtirol.it\nxn--trentino-sdtirol-szb.it\ntrentino-sued-tirol.it\ntrentino-suedtirol.it\ntrentino.it\ntrentinoa-adige.it\ntrentinoaadige.it\ntrentinoalto-adige.it\ntrentinoaltoadige.it\ntrentinos-tirol.it\ntrentinostirol.it\ntrentinosud-tirol.it\nxn--trentinosd-tirol-rzb.it\ntrentinosudtirol.it\nxn--trentinosdtirol-7vb.it\ntrentinosued-tirol.it\ntrentinosuedtirol.it\ntrentinsud-tirol.it\nxn--trentinsd-tirol-6vb.it\ntrentinsudtirol.it\nxn--trentinsdtirol-nsb.it\ntrentinsued-tirol.it\ntrentinsuedtirol.it\ntuscany.it\numb.it\numbria.it\nval-d-aosta.it\nval-daosta.it\nvald-aosta.it\nvaldaosta.it\nvalle-aosta.it\nvalle-d-aosta.it\nvalle-daosta.it\nvalleaosta.it\nvalled-aosta.it\nvalledaosta.it\nvallee-aoste.it\nxn--valle-aoste-ebb.it\nvallee-d-aoste.it\nxn--valle-d-aoste-ehb.it\nvalleeaoste.it\nxn--valleaoste-e7a.it\nvalleedaoste.it\nxn--valledaoste-ebb.it\nvao.it\nvda.it\nven.it\nveneto.it\nag.it\nagrigento.it\nal.it\nalessandria.it\nalto-adige.it\naltoadige.it\nan.it\nancona.it\nandria-barletta-trani.it\nandria-trani-barletta.it\nandriabarlettatrani.it\nandriatranibarletta.it\nao.it\naosta.it\naoste.it\nap.it\naq.it\naquila.it\nar.it\narezzo.it\nascoli-piceno.it\nascolipiceno.it\nasti.it\nat.it\nav.it\navellino.it\nba.it\nbalsan-sudtirol.it\nxn--balsan-sdtirol-nsb.it\nbalsan-suedtirol.it\nbalsan.it\nbari.it\nbarletta-trani-andria.it\nbarlettatraniandria.it\nbelluno.it\nbenevento.it\nbergamo.it\nbg.it\nbi.it\nbiella.it\nbl.it\nbn.it\nbo.it\nbologna.it\nbolzano-altoadige.it\nbolzano.it\nbozen-sudtirol.it\nxn--bozen-sdtirol-2ob.it\nbozen-suedtirol.it\nbozen.it\nbr.it\nbrescia.it\nbrindisi.it\nbs.it\nbt.it\nbulsan-sudtirol.it\nxn--bulsan-sdtirol-nsb.it\nbulsan-suedtirol.it\nbulsan.it\nbz.it\nca.it\ncagliari.it\ncaltanissetta.it\ncampidano-medio.it\ncampidanomedio.it\ncampobasso.it\ncarbonia-iglesias.it\ncarboniaiglesias.it\ncarrara-massa.it\ncarraramassa.it\ncaserta.it\ncatania.it\ncatanzaro.it\ncb.it\nce.it\ncesena-forli.it\nxn--cesena-forl-mcb.it\ncesenaforli.it\nxn--cesenaforl-i8a.it\nch.it\nchieti.it\nci.it\ncl.it\ncn.it\nco.it\ncomo.it\ncosenza.it\ncr.it\ncremona.it\ncrotone.it\ncs.it\nct.it\ncuneo.it\ncz.it\ndell-ogliastra.it\ndellogliastra.it\nen.it\nenna.it\nfc.it\nfe.it\nfermo.it\nferrara.it\nfg.it\nfi.it\nfirenze.it\nflorence.it\nfm.it\nfoggia.it\nforli-cesena.it\nxn--forl-cesena-fcb.it\nforlicesena.it\nxn--forlcesena-c8a.it\nfr.it\nfrosinone.it\nge.it\ngenoa.it\ngenova.it\ngo.it\ngorizia.it\ngr.it\ngrosseto.it\niglesias-carbonia.it\niglesiascarbonia.it\nim.it\nimperia.it\nis.it\nisernia.it\nkr.it\nla-spezia.it\nlaquila.it\nlaspezia.it\nlatina.it\nlc.it\nle.it\nlecce.it\nlecco.it\nli.it\nlivorno.it\nlo.it\nlodi.it\nlt.it\nlu.it\nlucca.it\nmacerata.it\nmantova.it\nmassa-carrara.it\nmassacarrara.it\nmatera.it\nmb.it\nmc.it\nme.it\nmedio-campidano.it\nmediocampidano.it\nmessina.it\nmi.it\nmilan.it\nmilano.it\nmn.it\nmo.it\nmodena.it\nmonza-brianza.it\nmonza-e-della-brianza.it\nmonza.it\nmonzabrianza.it\nmonzaebrianza.it\nmonzaedellabrianza.it\nms.it\nmt.it\nna.it\nnaples.it\nnapoli.it\nno.it\nnovara.it\nnu.it\nnuoro.it\nog.it\nogliastra.it\nolbia-tempio.it\nolbiatempio.it\nor.it\noristano.it\not.it\npa.it\npadova.it\npadua.it\npalermo.it\nparma.it\npavia.it\npc.it\npd.it\npe.it\nperugia.it\npesaro-urbino.it\npesarourbino.it\npescara.it\npg.it\npi.it\npiacenza.it\npisa.it\npistoia.it\npn.it\npo.it\npordenone.it\npotenza.it\npr.it\nprato.it\npt.it\npu.it\npv.it\npz.it\nra.it\nragusa.it\nravenna.it\nrc.it\nre.it\nreggio-calabria.it\nreggio-emilia.it\nreggiocalabria.it\nreggioemilia.it\nrg.it\nri.it\nrieti.it\nrimini.it\nrm.it\nrn.it\nro.it\nroma.it\nrome.it\nrovigo.it\nsa.it\nsalerno.it\nsassari.it\nsavona.it\nsi.it\nsiena.it\nsiracusa.it\nso.it\nsondrio.it\nsp.it\nsr.it\nss.it\nsuedtirol.it\nxn--sdtirol-n2a.it\nsv.it\nta.it\ntaranto.it\nte.it\ntempio-olbia.it\ntempioolbia.it\nteramo.it\nterni.it\ntn.it\nto.it\ntorino.it\ntp.it\ntr.it\ntrani-andria-barletta.it\ntrani-barletta-andria.it\ntraniandriabarletta.it\ntranibarlettaandria.it\ntrapani.it\ntrento.it\ntreviso.it\ntrieste.it\nts.it\nturin.it\ntv.it\nud.it\nudine.it\nurbino-pesaro.it\nurbinopesaro.it\nva.it\nvarese.it\nvb.it\nvc.it\nve.it\nvenezia.it\nvenice.it\nverbania.it\nvercelli.it\nverona.it\nvi.it\nvibo-valentia.it\nvibovalentia.it\nvicenza.it\nviterbo.it\nvr.it\nvs.it\nvt.it\nvv.it\nje\nco.je\nnet.je\norg.je\n*.jm\njo\ncom.jo\norg.jo\nnet.jo\nedu.jo\nsch.jo\ngov.jo\nmil.jo\nname.jo\njobs\njp\nac.jp\nad.jp\nco.jp\ned.jp\ngo.jp\ngr.jp\nlg.jp\nne.jp\nor.jp\naichi.jp\nakita.jp\naomori.jp\nchiba.jp\nehime.jp\nfukui.jp\nfukuoka.jp\nfukushima.jp\ngifu.jp\ngunma.jp\nhiroshima.jp\nhokkaido.jp\nhyogo.jp\nibaraki.jp\nishikawa.jp\niwate.jp\nkagawa.jp\nkagoshima.jp\nkanagawa.jp\nkochi.jp\nkumamoto.jp\nkyoto.jp\nmie.jp\nmiyagi.jp\nmiyazaki.jp\nnagano.jp\nnagasaki.jp\nnara.jp\nniigata.jp\noita.jp\nokayama.jp\nokinawa.jp\nosaka.jp\nsaga.jp\nsaitama.jp\nshiga.jp\nshimane.jp\nshizuoka.jp\ntochigi.jp\ntokushima.jp\ntokyo.jp\ntottori.jp\ntoyama.jp\nwakayama.jp\nyamagata.jp\nyamaguchi.jp\nyamanashi.jp\nxn--4pvxs.jp\nxn--vgu402c.jp\nxn--c3s14m.jp\nxn--f6qx53a.jp\nxn--8pvr4u.jp\nxn--uist22h.jp\nxn--djrs72d6uy.jp\nxn--mkru45i.jp\nxn--0trq7p7nn.jp\nxn--8ltr62k.jp\nxn--2m4a15e.jp\nxn--efvn9s.jp\nxn--32vp30h.jp\nxn--4it797k.jp\nxn--1lqs71d.jp\nxn--5rtp49c.jp\nxn--5js045d.jp\nxn--ehqz56n.jp\nxn--1lqs03n.jp\nxn--qqqt11m.jp\nxn--kbrq7o.jp\nxn--pssu33l.jp\nxn--ntsq17g.jp\nxn--uisz3g.jp\nxn--6btw5a.jp\nxn--1ctwo.jp\nxn--6orx2r.jp\nxn--rht61e.jp\nxn--rht27z.jp\nxn--djty4k.jp\nxn--nit225k.jp\nxn--rht3d.jp\nxn--klty5x.jp\nxn--kltx9a.jp\nxn--kltp7d.jp\nxn--uuwu58a.jp\nxn--zbx025d.jp\nxn--ntso0iqx3a.jp\nxn--elqq16h.jp\nxn--4it168d.jp\nxn--klt787d.jp\nxn--rny31h.jp\nxn--7t0a264c.jp\nxn--5rtq34k.jp\nxn--k7yn95e.jp\nxn--tor131o.jp\nxn--d5qv7z876c.jp\n*.kawasaki.jp\n*.kitakyushu.jp\n*.kobe.jp\n*.nagoya.jp\n*.sapporo.jp\n*.sendai.jp\n*.yokohama.jp\n!city.kawasaki.jp\n!city.kitakyushu.jp\n!city.kobe.jp\n!city.nagoya.jp\n!city.sapporo.jp\n!city.sendai.jp\n!city.yokohama.jp\naisai.aichi.jp\nama.aichi.jp\nanjo.aichi.jp\nasuke.aichi.jp\nchiryu.aichi.jp\nchita.aichi.jp\nfuso.aichi.jp\ngamagori.aichi.jp\nhanda.aichi.jp\nhazu.aichi.jp\nhekinan.aichi.jp\nhigashiura.aichi.jp\nichinomiya.aichi.jp\ninazawa.aichi.jp\ninuyama.aichi.jp\nisshiki.aichi.jp\niwakura.aichi.jp\nkanie.aichi.jp\nkariya.aichi.jp\nkasugai.aichi.jp\nkira.aichi.jp\nkiyosu.aichi.jp\nkomaki.aichi.jp\nkonan.aichi.jp\nkota.aichi.jp\nmihama.aichi.jp\nmiyoshi.aichi.jp\nnishio.aichi.jp\nnisshin.aichi.jp\nobu.aichi.jp\noguchi.aichi.jp\noharu.aichi.jp\nokazaki.aichi.jp\nowariasahi.aichi.jp\nseto.aichi.jp\nshikatsu.aichi.jp\nshinshiro.aichi.jp\nshitara.aichi.jp\ntahara.aichi.jp\ntakahama.aichi.jp\ntobishima.aichi.jp\ntoei.aichi.jp\ntogo.aichi.jp\ntokai.aichi.jp\ntokoname.aichi.jp\ntoyoake.aichi.jp\ntoyohashi.aichi.jp\ntoyokawa.aichi.jp\ntoyone.aichi.jp\ntoyota.aichi.jp\ntsushima.aichi.jp\nyatomi.aichi.jp\nakita.akita.jp\ndaisen.akita.jp\nfujisato.akita.jp\ngojome.akita.jp\nhachirogata.akita.jp\nhappou.akita.jp\nhigashinaruse.akita.jp\nhonjo.akita.jp\nhonjyo.akita.jp\nikawa.akita.jp\nkamikoani.akita.jp\nkamioka.akita.jp\nkatagami.akita.jp\nkazuno.akita.jp\nkitaakita.akita.jp\nkosaka.akita.jp\nkyowa.akita.jp\nmisato.akita.jp\nmitane.akita.jp\nmoriyoshi.akita.jp\nnikaho.akita.jp\nnoshiro.akita.jp\nodate.akita.jp\noga.akita.jp\nogata.akita.jp\nsemboku.akita.jp\nyokote.akita.jp\nyurihonjo.akita.jp\naomori.aomori.jp\ngonohe.aomori.jp\nhachinohe.aomori.jp\nhashikami.aomori.jp\nhiranai.aomori.jp\nhirosaki.aomori.jp\nitayanagi.aomori.jp\nkuroishi.aomori.jp\nmisawa.aomori.jp\nmutsu.aomori.jp\nnakadomari.aomori.jp\nnoheji.aomori.jp\noirase.aomori.jp\nowani.aomori.jp\nrokunohe.aomori.jp\nsannohe.aomori.jp\nshichinohe.aomori.jp\nshingo.aomori.jp\ntakko.aomori.jp\ntowada.aomori.jp\ntsugaru.aomori.jp\ntsuruta.aomori.jp\nabiko.chiba.jp\nasahi.chiba.jp\nchonan.chiba.jp\nchosei.chiba.jp\nchoshi.chiba.jp\nchuo.chiba.jp\nfunabashi.chiba.jp\nfuttsu.chiba.jp\nhanamigawa.chiba.jp\nichihara.chiba.jp\nichikawa.chiba.jp\nichinomiya.chiba.jp\ninzai.chiba.jp\nisumi.chiba.jp\nkamagaya.chiba.jp\nkamogawa.chiba.jp\nkashiwa.chiba.jp\nkatori.chiba.jp\nkatsuura.chiba.jp\nkimitsu.chiba.jp\nkisarazu.chiba.jp\nkozaki.chiba.jp\nkujukuri.chiba.jp\nkyonan.chiba.jp\nmatsudo.chiba.jp\nmidori.chiba.jp\nmihama.chiba.jp\nminamiboso.chiba.jp\nmobara.chiba.jp\nmutsuzawa.chiba.jp\nnagara.chiba.jp\nnagareyama.chiba.jp\nnarashino.chiba.jp\nnarita.chiba.jp\nnoda.chiba.jp\noamishirasato.chiba.jp\nomigawa.chiba.jp\nonjuku.chiba.jp\notaki.chiba.jp\nsakae.chiba.jp\nsakura.chiba.jp\nshimofusa.chiba.jp\nshirako.chiba.jp\nshiroi.chiba.jp\nshisui.chiba.jp\nsodegaura.chiba.jp\nsosa.chiba.jp\ntako.chiba.jp\ntateyama.chiba.jp\ntogane.chiba.jp\ntohnosho.chiba.jp\ntomisato.chiba.jp\nurayasu.chiba.jp\nyachimata.chiba.jp\nyachiyo.chiba.jp\nyokaichiba.chiba.jp\nyokoshibahikari.chiba.jp\nyotsukaido.chiba.jp\nainan.ehime.jp\nhonai.ehime.jp\nikata.ehime.jp\nimabari.ehime.jp\niyo.ehime.jp\nkamijima.ehime.jp\nkihoku.ehime.jp\nkumakogen.ehime.jp\nmasaki.ehime.jp\nmatsuno.ehime.jp\nmatsuyama.ehime.jp\nnamikata.ehime.jp\nniihama.ehime.jp\nozu.ehime.jp\nsaijo.ehime.jp\nseiyo.ehime.jp\nshikokuchuo.ehime.jp\ntobe.ehime.jp\ntoon.ehime.jp\nuchiko.ehime.jp\nuwajima.ehime.jp\nyawatahama.ehime.jp\nechizen.fukui.jp\neiheiji.fukui.jp\nfukui.fukui.jp\nikeda.fukui.jp\nkatsuyama.fukui.jp\nmihama.fukui.jp\nminamiechizen.fukui.jp\nobama.fukui.jp\nohi.fukui.jp\nono.fukui.jp\nsabae.fukui.jp\nsakai.fukui.jp\ntakahama.fukui.jp\ntsuruga.fukui.jp\nwakasa.fukui.jp\nashiya.fukuoka.jp\nbuzen.fukuoka.jp\nchikugo.fukuoka.jp\nchikuho.fukuoka.jp\nchikujo.fukuoka.jp\nchikushino.fukuoka.jp\nchikuzen.fukuoka.jp\nchuo.fukuoka.jp\ndazaifu.fukuoka.jp\nfukuchi.fukuoka.jp\nhakata.fukuoka.jp\nhigashi.fukuoka.jp\nhirokawa.fukuoka.jp\nhisayama.fukuoka.jp\niizuka.fukuoka.jp\ninatsuki.fukuoka.jp\nkaho.fukuoka.jp\nkasuga.fukuoka.jp\nkasuya.fukuoka.jp\nkawara.fukuoka.jp\nkeisen.fukuoka.jp\nkoga.fukuoka.jp\nkurate.fukuoka.jp\nkurogi.fukuoka.jp\nkurume.fukuoka.jp\nminami.fukuoka.jp\nmiyako.fukuoka.jp\nmiyama.fukuoka.jp\nmiyawaka.fukuoka.jp\nmizumaki.fukuoka.jp\nmunakata.fukuoka.jp\nnakagawa.fukuoka.jp\nnakama.fukuoka.jp\nnishi.fukuoka.jp\nnogata.fukuoka.jp\nogori.fukuoka.jp\nokagaki.fukuoka.jp\nokawa.fukuoka.jp\noki.fukuoka.jp\nomuta.fukuoka.jp\nonga.fukuoka.jp\nonojo.fukuoka.jp\noto.fukuoka.jp\nsaigawa.fukuoka.jp\nsasaguri.fukuoka.jp\nshingu.fukuoka.jp\nshinyoshitomi.fukuoka.jp\nshonai.fukuoka.jp\nsoeda.fukuoka.jp\nsue.fukuoka.jp\ntachiarai.fukuoka.jp\ntagawa.fukuoka.jp\ntakata.fukuoka.jp\ntoho.fukuoka.jp\ntoyotsu.fukuoka.jp\ntsuiki.fukuoka.jp\nukiha.fukuoka.jp\numi.fukuoka.jp\nusui.fukuoka.jp\nyamada.fukuoka.jp\nyame.fukuoka.jp\nyanagawa.fukuoka.jp\nyukuhashi.fukuoka.jp\naizubange.fukushima.jp\naizumisato.fukushima.jp\naizuwakamatsu.fukushima.jp\nasakawa.fukushima.jp\nbandai.fukushima.jp\ndate.fukushima.jp\nfukushima.fukushima.jp\nfurudono.fukushima.jp\nfutaba.fukushima.jp\nhanawa.fukushima.jp\nhigashi.fukushima.jp\nhirata.fukushima.jp\nhirono.fukushima.jp\niitate.fukushima.jp\ninawashiro.fukushima.jp\nishikawa.fukushima.jp\niwaki.fukushima.jp\nizumizaki.fukushima.jp\nkagamiishi.fukushima.jp\nkaneyama.fukushima.jp\nkawamata.fukushima.jp\nkitakata.fukushima.jp\nkitashiobara.fukushima.jp\nkoori.fukushima.jp\nkoriyama.fukushima.jp\nkunimi.fukushima.jp\nmiharu.fukushima.jp\nmishima.fukushima.jp\nnamie.fukushima.jp\nnango.fukushima.jp\nnishiaizu.fukushima.jp\nnishigo.fukushima.jp\nokuma.fukushima.jp\nomotego.fukushima.jp\nono.fukushima.jp\notama.fukushima.jp\nsamegawa.fukushima.jp\nshimogo.fukushima.jp\nshirakawa.fukushima.jp\nshowa.fukushima.jp\nsoma.fukushima.jp\nsukagawa.fukushima.jp\ntaishin.fukushima.jp\ntamakawa.fukushima.jp\ntanagura.fukushima.jp\ntenei.fukushima.jp\nyabuki.fukushima.jp\nyamato.fukushima.jp\nyamatsuri.fukushima.jp\nyanaizu.fukushima.jp\nyugawa.fukushima.jp\nanpachi.gifu.jp\nena.gifu.jp\ngifu.gifu.jp\nginan.gifu.jp\ngodo.gifu.jp\ngujo.gifu.jp\nhashima.gifu.jp\nhichiso.gifu.jp\nhida.gifu.jp\nhigashishirakawa.gifu.jp\nibigawa.gifu.jp\nikeda.gifu.jp\nkakamigahara.gifu.jp\nkani.gifu.jp\nkasahara.gifu.jp\nkasamatsu.gifu.jp\nkawaue.gifu.jp\nkitagata.gifu.jp\nmino.gifu.jp\nminokamo.gifu.jp\nmitake.gifu.jp\nmizunami.gifu.jp\nmotosu.gifu.jp\nnakatsugawa.gifu.jp\nogaki.gifu.jp\nsakahogi.gifu.jp\nseki.gifu.jp\nsekigahara.gifu.jp\nshirakawa.gifu.jp\ntajimi.gifu.jp\ntakayama.gifu.jp\ntarui.gifu.jp\ntoki.gifu.jp\ntomika.gifu.jp\nwanouchi.gifu.jp\nyamagata.gifu.jp\nyaotsu.gifu.jp\nyoro.gifu.jp\nannaka.gunma.jp\nchiyoda.gunma.jp\nfujioka.gunma.jp\nhigashiagatsuma.gunma.jp\nisesaki.gunma.jp\nitakura.gunma.jp\nkanna.gunma.jp\nkanra.gunma.jp\nkatashina.gunma.jp\nkawaba.gunma.jp\nkiryu.gunma.jp\nkusatsu.gunma.jp\nmaebashi.gunma.jp\nmeiwa.gunma.jp\nmidori.gunma.jp\nminakami.gunma.jp\nnaganohara.gunma.jp\nnakanojo.gunma.jp\nnanmoku.gunma.jp\nnumata.gunma.jp\noizumi.gunma.jp\nora.gunma.jp\nota.gunma.jp\nshibukawa.gunma.jp\nshimonita.gunma.jp\nshinto.gunma.jp\nshowa.gunma.jp\ntakasaki.gunma.jp\ntakayama.gunma.jp\ntamamura.gunma.jp\ntatebayashi.gunma.jp\ntomioka.gunma.jp\ntsukiyono.gunma.jp\ntsumagoi.gunma.jp\nueno.gunma.jp\nyoshioka.gunma.jp\nasaminami.hiroshima.jp\ndaiwa.hiroshima.jp\netajima.hiroshima.jp\nfuchu.hiroshima.jp\nfukuyama.hiroshima.jp\nhatsukaichi.hiroshima.jp\nhigashihiroshima.hiroshima.jp\nhongo.hiroshima.jp\njinsekikogen.hiroshima.jp\nkaita.hiroshima.jp\nkui.hiroshima.jp\nkumano.hiroshima.jp\nkure.hiroshima.jp\nmihara.hiroshima.jp\nmiyoshi.hiroshima.jp\nnaka.hiroshima.jp\nonomichi.hiroshima.jp\nosakikamijima.hiroshima.jp\notake.hiroshima.jp\nsaka.hiroshima.jp\nsera.hiroshima.jp\nseranishi.hiroshima.jp\nshinichi.hiroshima.jp\nshobara.hiroshima.jp\ntakehara.hiroshima.jp\nabashiri.hokkaido.jp\nabira.hokkaido.jp\naibetsu.hokkaido.jp\nakabira.hokkaido.jp\nakkeshi.hokkaido.jp\nasahikawa.hokkaido.jp\nashibetsu.hokkaido.jp\nashoro.hokkaido.jp\nassabu.hokkaido.jp\natsuma.hokkaido.jp\nbibai.hokkaido.jp\nbiei.hokkaido.jp\nbifuka.hokkaido.jp\nbihoro.hokkaido.jp\nbiratori.hokkaido.jp\nchippubetsu.hokkaido.jp\nchitose.hokkaido.jp\ndate.hokkaido.jp\nebetsu.hokkaido.jp\nembetsu.hokkaido.jp\neniwa.hokkaido.jp\nerimo.hokkaido.jp\nesan.hokkaido.jp\nesashi.hokkaido.jp\nfukagawa.hokkaido.jp\nfukushima.hokkaido.jp\nfurano.hokkaido.jp\nfurubira.hokkaido.jp\nhaboro.hokkaido.jp\nhakodate.hokkaido.jp\nhamatonbetsu.hokkaido.jp\nhidaka.hokkaido.jp\nhigashikagura.hokkaido.jp\nhigashikawa.hokkaido.jp\nhiroo.hokkaido.jp\nhokuryu.hokkaido.jp\nhokuto.hokkaido.jp\nhonbetsu.hokkaido.jp\nhorokanai.hokkaido.jp\nhoronobe.hokkaido.jp\nikeda.hokkaido.jp\nimakane.hokkaido.jp\nishikari.hokkaido.jp\niwamizawa.hokkaido.jp\niwanai.hokkaido.jp\nkamifurano.hokkaido.jp\nkamikawa.hokkaido.jp\nkamishihoro.hokkaido.jp\nkamisunagawa.hokkaido.jp\nkamoenai.hokkaido.jp\nkayabe.hokkaido.jp\nkembuchi.hokkaido.jp\nkikonai.hokkaido.jp\nkimobetsu.hokkaido.jp\nkitahiroshima.hokkaido.jp\nkitami.hokkaido.jp\nkiyosato.hokkaido.jp\nkoshimizu.hokkaido.jp\nkunneppu.hokkaido.jp\nkuriyama.hokkaido.jp\nkuromatsunai.hokkaido.jp\nkushiro.hokkaido.jp\nkutchan.hokkaido.jp\nkyowa.hokkaido.jp\nmashike.hokkaido.jp\nmatsumae.hokkaido.jp\nmikasa.hokkaido.jp\nminamifurano.hokkaido.jp\nmombetsu.hokkaido.jp\nmoseushi.hokkaido.jp\nmukawa.hokkaido.jp\nmuroran.hokkaido.jp\nnaie.hokkaido.jp\nnakagawa.hokkaido.jp\nnakasatsunai.hokkaido.jp\nnakatombetsu.hokkaido.jp\nnanae.hokkaido.jp\nnanporo.hokkaido.jp\nnayoro.hokkaido.jp\nnemuro.hokkaido.jp\nniikappu.hokkaido.jp\nniki.hokkaido.jp\nnishiokoppe.hokkaido.jp\nnoboribetsu.hokkaido.jp\nnumata.hokkaido.jp\nobihiro.hokkaido.jp\nobira.hokkaido.jp\noketo.hokkaido.jp\nokoppe.hokkaido.jp\notaru.hokkaido.jp\notobe.hokkaido.jp\notofuke.hokkaido.jp\notoineppu.hokkaido.jp\noumu.hokkaido.jp\nozora.hokkaido.jp\npippu.hokkaido.jp\nrankoshi.hokkaido.jp\nrebun.hokkaido.jp\nrikubetsu.hokkaido.jp\nrishiri.hokkaido.jp\nrishirifuji.hokkaido.jp\nsaroma.hokkaido.jp\nsarufutsu.hokkaido.jp\nshakotan.hokkaido.jp\nshari.hokkaido.jp\nshibecha.hokkaido.jp\nshibetsu.hokkaido.jp\nshikabe.hokkaido.jp\nshikaoi.hokkaido.jp\nshimamaki.hokkaido.jp\nshimizu.hokkaido.jp\nshimokawa.hokkaido.jp\nshinshinotsu.hokkaido.jp\nshintoku.hokkaido.jp\nshiranuka.hokkaido.jp\nshiraoi.hokkaido.jp\nshiriuchi.hokkaido.jp\nsobetsu.hokkaido.jp\nsunagawa.hokkaido.jp\ntaiki.hokkaido.jp\ntakasu.hokkaido.jp\ntakikawa.hokkaido.jp\ntakinoue.hokkaido.jp\nteshikaga.hokkaido.jp\ntobetsu.hokkaido.jp\ntohma.hokkaido.jp\ntomakomai.hokkaido.jp\ntomari.hokkaido.jp\ntoya.hokkaido.jp\ntoyako.hokkaido.jp\ntoyotomi.hokkaido.jp\ntoyoura.hokkaido.jp\ntsubetsu.hokkaido.jp\ntsukigata.hokkaido.jp\nurakawa.hokkaido.jp\nurausu.hokkaido.jp\nuryu.hokkaido.jp\nutashinai.hokkaido.jp\nwakkanai.hokkaido.jp\nwassamu.hokkaido.jp\nyakumo.hokkaido.jp\nyoichi.hokkaido.jp\naioi.hyogo.jp\nakashi.hyogo.jp\nako.hyogo.jp\namagasaki.hyogo.jp\naogaki.hyogo.jp\nasago.hyogo.jp\nashiya.hyogo.jp\nawaji.hyogo.jp\nfukusaki.hyogo.jp\ngoshiki.hyogo.jp\nharima.hyogo.jp\nhimeji.hyogo.jp\nichikawa.hyogo.jp\ninagawa.hyogo.jp\nitami.hyogo.jp\nkakogawa.hyogo.jp\nkamigori.hyogo.jp\nkamikawa.hyogo.jp\nkasai.hyogo.jp\nkasuga.hyogo.jp\nkawanishi.hyogo.jp\nmiki.hyogo.jp\nminamiawaji.hyogo.jp\nnishinomiya.hyogo.jp\nnishiwaki.hyogo.jp\nono.hyogo.jp\nsanda.hyogo.jp\nsannan.hyogo.jp\nsasayama.hyogo.jp\nsayo.hyogo.jp\nshingu.hyogo.jp\nshinonsen.hyogo.jp\nshiso.hyogo.jp\nsumoto.hyogo.jp\ntaishi.hyogo.jp\ntaka.hyogo.jp\ntakarazuka.hyogo.jp\ntakasago.hyogo.jp\ntakino.hyogo.jp\ntamba.hyogo.jp\ntatsuno.hyogo.jp\ntoyooka.hyogo.jp\nyabu.hyogo.jp\nyashiro.hyogo.jp\nyoka.hyogo.jp\nyokawa.hyogo.jp\nami.ibaraki.jp\nasahi.ibaraki.jp\nbando.ibaraki.jp\nchikusei.ibaraki.jp\ndaigo.ibaraki.jp\nfujishiro.ibaraki.jp\nhitachi.ibaraki.jp\nhitachinaka.ibaraki.jp\nhitachiomiya.ibaraki.jp\nhitachiota.ibaraki.jp\nibaraki.ibaraki.jp\nina.ibaraki.jp\ninashiki.ibaraki.jp\nitako.ibaraki.jp\niwama.ibaraki.jp\njoso.ibaraki.jp\nkamisu.ibaraki.jp\nkasama.ibaraki.jp\nkashima.ibaraki.jp\nkasumigaura.ibaraki.jp\nkoga.ibaraki.jp\nmiho.ibaraki.jp\nmito.ibaraki.jp\nmoriya.ibaraki.jp\nnaka.ibaraki.jp\nnamegata.ibaraki.jp\noarai.ibaraki.jp\nogawa.ibaraki.jp\nomitama.ibaraki.jp\nryugasaki.ibaraki.jp\nsakai.ibaraki.jp\nsakuragawa.ibaraki.jp\nshimodate.ibaraki.jp\nshimotsuma.ibaraki.jp\nshirosato.ibaraki.jp\nsowa.ibaraki.jp\nsuifu.ibaraki.jp\ntakahagi.ibaraki.jp\ntamatsukuri.ibaraki.jp\ntokai.ibaraki.jp\ntomobe.ibaraki.jp\ntone.ibaraki.jp\ntoride.ibaraki.jp\ntsuchiura.ibaraki.jp\ntsukuba.ibaraki.jp\nuchihara.ibaraki.jp\nushiku.ibaraki.jp\nyachiyo.ibaraki.jp\nyamagata.ibaraki.jp\nyawara.ibaraki.jp\nyuki.ibaraki.jp\nanamizu.ishikawa.jp\nhakui.ishikawa.jp\nhakusan.ishikawa.jp\nkaga.ishikawa.jp\nkahoku.ishikawa.jp\nkanazawa.ishikawa.jp\nkawakita.ishikawa.jp\nkomatsu.ishikawa.jp\nnakanoto.ishikawa.jp\nnanao.ishikawa.jp\nnomi.ishikawa.jp\nnonoichi.ishikawa.jp\nnoto.ishikawa.jp\nshika.ishikawa.jp\nsuzu.ishikawa.jp\ntsubata.ishikawa.jp\ntsurugi.ishikawa.jp\nuchinada.ishikawa.jp\nwajima.ishikawa.jp\nfudai.iwate.jp\nfujisawa.iwate.jp\nhanamaki.iwate.jp\nhiraizumi.iwate.jp\nhirono.iwate.jp\nichinohe.iwate.jp\nichinoseki.iwate.jp\niwaizumi.iwate.jp\niwate.iwate.jp\njoboji.iwate.jp\nkamaishi.iwate.jp\nkanegasaki.iwate.jp\nkarumai.iwate.jp\nkawai.iwate.jp\nkitakami.iwate.jp\nkuji.iwate.jp\nkunohe.iwate.jp\nkuzumaki.iwate.jp\nmiyako.iwate.jp\nmizusawa.iwate.jp\nmorioka.iwate.jp\nninohe.iwate.jp\nnoda.iwate.jp\nofunato.iwate.jp\noshu.iwate.jp\notsuchi.iwate.jp\nrikuzentakata.iwate.jp\nshiwa.iwate.jp\nshizukuishi.iwate.jp\nsumita.iwate.jp\ntanohata.iwate.jp\ntono.iwate.jp\nyahaba.iwate.jp\nyamada.iwate.jp\nayagawa.kagawa.jp\nhigashikagawa.kagawa.jp\nkanonji.kagawa.jp\nkotohira.kagawa.jp\nmanno.kagawa.jp\nmarugame.kagawa.jp\nmitoyo.kagawa.jp\nnaoshima.kagawa.jp\nsanuki.kagawa.jp\ntadotsu.kagawa.jp\ntakamatsu.kagawa.jp\ntonosho.kagawa.jp\nuchinomi.kagawa.jp\nutazu.kagawa.jp\nzentsuji.kagawa.jp\nakune.kagoshima.jp\namami.kagoshima.jp\nhioki.kagoshima.jp\nisa.kagoshima.jp\nisen.kagoshima.jp\nizumi.kagoshima.jp\nkagoshima.kagoshima.jp\nkanoya.kagoshima.jp\nkawanabe.kagoshima.jp\nkinko.kagoshima.jp\nkouyama.kagoshima.jp\nmakurazaki.kagoshima.jp\nmatsumoto.kagoshima.jp\nminamitane.kagoshima.jp\nnakatane.kagoshima.jp\nnishinoomote.kagoshima.jp\nsatsumasendai.kagoshima.jp\nsoo.kagoshima.jp\ntarumizu.kagoshima.jp\nyusui.kagoshima.jp\naikawa.kanagawa.jp\natsugi.kanagawa.jp\nayase.kanagawa.jp\nchigasaki.kanagawa.jp\nebina.kanagawa.jp\nfujisawa.kanagawa.jp\nhadano.kanagawa.jp\nhakone.kanagawa.jp\nhiratsuka.kanagawa.jp\nisehara.kanagawa.jp\nkaisei.kanagawa.jp\nkamakura.kanagawa.jp\nkiyokawa.kanagawa.jp\nmatsuda.kanagawa.jp\nminamiashigara.kanagawa.jp\nmiura.kanagawa.jp\nnakai.kanagawa.jp\nninomiya.kanagawa.jp\nodawara.kanagawa.jp\noi.kanagawa.jp\noiso.kanagawa.jp\nsagamihara.kanagawa.jp\nsamukawa.kanagawa.jp\ntsukui.kanagawa.jp\nyamakita.kanagawa.jp\nyamato.kanagawa.jp\nyokosuka.kanagawa.jp\nyugawara.kanagawa.jp\nzama.kanagawa.jp\nzushi.kanagawa.jp\naki.kochi.jp\ngeisei.kochi.jp\nhidaka.kochi.jp\nhigashitsuno.kochi.jp\nino.kochi.jp\nkagami.kochi.jp\nkami.kochi.jp\nkitagawa.kochi.jp\nkochi.kochi.jp\nmihara.kochi.jp\nmotoyama.kochi.jp\nmuroto.kochi.jp\nnahari.kochi.jp\nnakamura.kochi.jp\nnankoku.kochi.jp\nnishitosa.kochi.jp\nniyodogawa.kochi.jp\nochi.kochi.jp\nokawa.kochi.jp\notoyo.kochi.jp\notsuki.kochi.jp\nsakawa.kochi.jp\nsukumo.kochi.jp\nsusaki.kochi.jp\ntosa.kochi.jp\ntosashimizu.kochi.jp\ntoyo.kochi.jp\ntsuno.kochi.jp\numaji.kochi.jp\nyasuda.kochi.jp\nyusuhara.kochi.jp\namakusa.kumamoto.jp\narao.kumamoto.jp\naso.kumamoto.jp\nchoyo.kumamoto.jp\ngyokuto.kumamoto.jp\nkamiamakusa.kumamoto.jp\nkikuchi.kumamoto.jp\nkumamoto.kumamoto.jp\nmashiki.kumamoto.jp\nmifune.kumamoto.jp\nminamata.kumamoto.jp\nminamioguni.kumamoto.jp\nnagasu.kumamoto.jp\nnishihara.kumamoto.jp\noguni.kumamoto.jp\nozu.kumamoto.jp\nsumoto.kumamoto.jp\ntakamori.kumamoto.jp\nuki.kumamoto.jp\nuto.kumamoto.jp\nyamaga.kumamoto.jp\nyamato.kumamoto.jp\nyatsushiro.kumamoto.jp\nayabe.kyoto.jp\nfukuchiyama.kyoto.jp\nhigashiyama.kyoto.jp\nide.kyoto.jp\nine.kyoto.jp\njoyo.kyoto.jp\nkameoka.kyoto.jp\nkamo.kyoto.jp\nkita.kyoto.jp\nkizu.kyoto.jp\nkumiyama.kyoto.jp\nkyotamba.kyoto.jp\nkyotanabe.kyoto.jp\nkyotango.kyoto.jp\nmaizuru.kyoto.jp\nminami.kyoto.jp\nminamiyamashiro.kyoto.jp\nmiyazu.kyoto.jp\nmuko.kyoto.jp\nnagaokakyo.kyoto.jp\nnakagyo.kyoto.jp\nnantan.kyoto.jp\noyamazaki.kyoto.jp\nsakyo.kyoto.jp\nseika.kyoto.jp\ntanabe.kyoto.jp\nuji.kyoto.jp\nujitawara.kyoto.jp\nwazuka.kyoto.jp\nyamashina.kyoto.jp\nyawata.kyoto.jp\nasahi.mie.jp\ninabe.mie.jp\nise.mie.jp\nkameyama.mie.jp\nkawagoe.mie.jp\nkiho.mie.jp\nkisosaki.mie.jp\nkiwa.mie.jp\nkomono.mie.jp\nkumano.mie.jp\nkuwana.mie.jp\nmatsusaka.mie.jp\nmeiwa.mie.jp\nmihama.mie.jp\nminamiise.mie.jp\nmisugi.mie.jp\nmiyama.mie.jp\nnabari.mie.jp\nshima.mie.jp\nsuzuka.mie.jp\ntado.mie.jp\ntaiki.mie.jp\ntaki.mie.jp\ntamaki.mie.jp\ntoba.mie.jp\ntsu.mie.jp\nudono.mie.jp\nureshino.mie.jp\nwatarai.mie.jp\nyokkaichi.mie.jp\nfurukawa.miyagi.jp\nhigashimatsushima.miyagi.jp\nishinomaki.miyagi.jp\niwanuma.miyagi.jp\nkakuda.miyagi.jp\nkami.miyagi.jp\nkawasaki.miyagi.jp\nmarumori.miyagi.jp\nmatsushima.miyagi.jp\nminamisanriku.miyagi.jp\nmisato.miyagi.jp\nmurata.miyagi.jp\nnatori.miyagi.jp\nogawara.miyagi.jp\nohira.miyagi.jp\nonagawa.miyagi.jp\nosaki.miyagi.jp\nrifu.miyagi.jp\nsemine.miyagi.jp\nshibata.miyagi.jp\nshichikashuku.miyagi.jp\nshikama.miyagi.jp\nshiogama.miyagi.jp\nshiroishi.miyagi.jp\ntagajo.miyagi.jp\ntaiwa.miyagi.jp\ntome.miyagi.jp\ntomiya.miyagi.jp\nwakuya.miyagi.jp\nwatari.miyagi.jp\nyamamoto.miyagi.jp\nzao.miyagi.jp\naya.miyazaki.jp\nebino.miyazaki.jp\ngokase.miyazaki.jp\nhyuga.miyazaki.jp\nkadogawa.miyazaki.jp\nkawaminami.miyazaki.jp\nkijo.miyazaki.jp\nkitagawa.miyazaki.jp\nkitakata.miyazaki.jp\nkitaura.miyazaki.jp\nkobayashi.miyazaki.jp\nkunitomi.miyazaki.jp\nkushima.miyazaki.jp\nmimata.miyazaki.jp\nmiyakonojo.miyazaki.jp\nmiyazaki.miyazaki.jp\nmorotsuka.miyazaki.jp\nnichinan.miyazaki.jp\nnishimera.miyazaki.jp\nnobeoka.miyazaki.jp\nsaito.miyazaki.jp\nshiiba.miyazaki.jp\nshintomi.miyazaki.jp\ntakaharu.miyazaki.jp\ntakanabe.miyazaki.jp\ntakazaki.miyazaki.jp\ntsuno.miyazaki.jp\nachi.nagano.jp\nagematsu.nagano.jp\nanan.nagano.jp\naoki.nagano.jp\nasahi.nagano.jp\nazumino.nagano.jp\nchikuhoku.nagano.jp\nchikuma.nagano.jp\nchino.nagano.jp\nfujimi.nagano.jp\nhakuba.nagano.jp\nhara.nagano.jp\nhiraya.nagano.jp\niida.nagano.jp\niijima.nagano.jp\niiyama.nagano.jp\niizuna.nagano.jp\nikeda.nagano.jp\nikusaka.nagano.jp\nina.nagano.jp\nkaruizawa.nagano.jp\nkawakami.nagano.jp\nkiso.nagano.jp\nkisofukushima.nagano.jp\nkitaaiki.nagano.jp\nkomagane.nagano.jp\nkomoro.nagano.jp\nmatsukawa.nagano.jp\nmatsumoto.nagano.jp\nmiasa.nagano.jp\nminamiaiki.nagano.jp\nminamimaki.nagano.jp\nminamiminowa.nagano.jp\nminowa.nagano.jp\nmiyada.nagano.jp\nmiyota.nagano.jp\nmochizuki.nagano.jp\nnagano.nagano.jp\nnagawa.nagano.jp\nnagiso.nagano.jp\nnakagawa.nagano.jp\nnakano.nagano.jp\nnozawaonsen.nagano.jp\nobuse.nagano.jp\nogawa.nagano.jp\nokaya.nagano.jp\nomachi.nagano.jp\nomi.nagano.jp\nookuwa.nagano.jp\nooshika.nagano.jp\notaki.nagano.jp\notari.nagano.jp\nsakae.nagano.jp\nsakaki.nagano.jp\nsaku.nagano.jp\nsakuho.nagano.jp\nshimosuwa.nagano.jp\nshinanomachi.nagano.jp\nshiojiri.nagano.jp\nsuwa.nagano.jp\nsuzaka.nagano.jp\ntakagi.nagano.jp\ntakamori.nagano.jp\ntakayama.nagano.jp\ntateshina.nagano.jp\ntatsuno.nagano.jp\ntogakushi.nagano.jp\ntogura.nagano.jp\ntomi.nagano.jp\nueda.nagano.jp\nwada.nagano.jp\nyamagata.nagano.jp\nyamanouchi.nagano.jp\nyasaka.nagano.jp\nyasuoka.nagano.jp\nchijiwa.nagasaki.jp\nfutsu.nagasaki.jp\ngoto.nagasaki.jp\nhasami.nagasaki.jp\nhirado.nagasaki.jp\niki.nagasaki.jp\nisahaya.nagasaki.jp\nkawatana.nagasaki.jp\nkuchinotsu.nagasaki.jp\nmatsuura.nagasaki.jp\nnagasaki.nagasaki.jp\nobama.nagasaki.jp\nomura.nagasaki.jp\noseto.nagasaki.jp\nsaikai.nagasaki.jp\nsasebo.nagasaki.jp\nseihi.nagasaki.jp\nshimabara.nagasaki.jp\nshinkamigoto.nagasaki.jp\ntogitsu.nagasaki.jp\ntsushima.nagasaki.jp\nunzen.nagasaki.jp\nando.nara.jp\ngose.nara.jp\nheguri.nara.jp\nhigashiyoshino.nara.jp\nikaruga.nara.jp\nikoma.nara.jp\nkamikitayama.nara.jp\nkanmaki.nara.jp\nkashiba.nara.jp\nkashihara.nara.jp\nkatsuragi.nara.jp\nkawai.nara.jp\nkawakami.nara.jp\nkawanishi.nara.jp\nkoryo.nara.jp\nkurotaki.nara.jp\nmitsue.nara.jp\nmiyake.nara.jp\nnara.nara.jp\nnosegawa.nara.jp\noji.nara.jp\nouda.nara.jp\noyodo.nara.jp\nsakurai.nara.jp\nsango.nara.jp\nshimoichi.nara.jp\nshimokitayama.nara.jp\nshinjo.nara.jp\nsoni.nara.jp\ntakatori.nara.jp\ntawaramoto.nara.jp\ntenkawa.nara.jp\ntenri.nara.jp\nuda.nara.jp\nyamatokoriyama.nara.jp\nyamatotakada.nara.jp\nyamazoe.nara.jp\nyoshino.nara.jp\naga.niigata.jp\nagano.niigata.jp\ngosen.niigata.jp\nitoigawa.niigata.jp\nizumozaki.niigata.jp\njoetsu.niigata.jp\nkamo.niigata.jp\nkariwa.niigata.jp\nkashiwazaki.niigata.jp\nminamiuonuma.niigata.jp\nmitsuke.niigata.jp\nmuika.niigata.jp\nmurakami.niigata.jp\nmyoko.niigata.jp\nnagaoka.niigata.jp\nniigata.niigata.jp\nojiya.niigata.jp\nomi.niigata.jp\nsado.niigata.jp\nsanjo.niigata.jp\nseiro.niigata.jp\nseirou.niigata.jp\nsekikawa.niigata.jp\nshibata.niigata.jp\ntagami.niigata.jp\ntainai.niigata.jp\ntochio.niigata.jp\ntokamachi.niigata.jp\ntsubame.niigata.jp\ntsunan.niigata.jp\nuonuma.niigata.jp\nyahiko.niigata.jp\nyoita.niigata.jp\nyuzawa.niigata.jp\nbeppu.oita.jp\nbungoono.oita.jp\nbungotakada.oita.jp\nhasama.oita.jp\nhiji.oita.jp\nhimeshima.oita.jp\nhita.oita.jp\nkamitsue.oita.jp\nkokonoe.oita.jp\nkuju.oita.jp\nkunisaki.oita.jp\nkusu.oita.jp\noita.oita.jp\nsaiki.oita.jp\ntaketa.oita.jp\ntsukumi.oita.jp\nusa.oita.jp\nusuki.oita.jp\nyufu.oita.jp\nakaiwa.okayama.jp\nasakuchi.okayama.jp\nbizen.okayama.jp\nhayashima.okayama.jp\nibara.okayama.jp\nkagamino.okayama.jp\nkasaoka.okayama.jp\nkibichuo.okayama.jp\nkumenan.okayama.jp\nkurashiki.okayama.jp\nmaniwa.okayama.jp\nmisaki.okayama.jp\nnagi.okayama.jp\nniimi.okayama.jp\nnishiawakura.okayama.jp\nokayama.okayama.jp\nsatosho.okayama.jp\nsetouchi.okayama.jp\nshinjo.okayama.jp\nshoo.okayama.jp\nsoja.okayama.jp\ntakahashi.okayama.jp\ntamano.okayama.jp\ntsuyama.okayama.jp\nwake.okayama.jp\nyakage.okayama.jp\naguni.okinawa.jp\nginowan.okinawa.jp\nginoza.okinawa.jp\ngushikami.okinawa.jp\nhaebaru.okinawa.jp\nhigashi.okinawa.jp\nhirara.okinawa.jp\niheya.okinawa.jp\nishigaki.okinawa.jp\nishikawa.okinawa.jp\nitoman.okinawa.jp\nizena.okinawa.jp\nkadena.okinawa.jp\nkin.okinawa.jp\nkitadaito.okinawa.jp\nkitanakagusuku.okinawa.jp\nkumejima.okinawa.jp\nkunigami.okinawa.jp\nminamidaito.okinawa.jp\nmotobu.okinawa.jp\nnago.okinawa.jp\nnaha.okinawa.jp\nnakagusuku.okinawa.jp\nnakijin.okinawa.jp\nnanjo.okinawa.jp\nnishihara.okinawa.jp\nogimi.okinawa.jp\nokinawa.okinawa.jp\nonna.okinawa.jp\nshimoji.okinawa.jp\ntaketomi.okinawa.jp\ntarama.okinawa.jp\ntokashiki.okinawa.jp\ntomigusuku.okinawa.jp\ntonaki.okinawa.jp\nurasoe.okinawa.jp\nuruma.okinawa.jp\nyaese.okinawa.jp\nyomitan.okinawa.jp\nyonabaru.okinawa.jp\nyonaguni.okinawa.jp\nzamami.okinawa.jp\nabeno.osaka.jp\nchihayaakasaka.osaka.jp\nchuo.osaka.jp\ndaito.osaka.jp\nfujiidera.osaka.jp\nhabikino.osaka.jp\nhannan.osaka.jp\nhigashiosaka.osaka.jp\nhigashisumiyoshi.osaka.jp\nhigashiyodogawa.osaka.jp\nhirakata.osaka.jp\nibaraki.osaka.jp\nikeda.osaka.jp\nizumi.osaka.jp\nizumiotsu.osaka.jp\nizumisano.osaka.jp\nkadoma.osaka.jp\nkaizuka.osaka.jp\nkanan.osaka.jp\nkashiwara.osaka.jp\nkatano.osaka.jp\nkawachinagano.osaka.jp\nkishiwada.osaka.jp\nkita.osaka.jp\nkumatori.osaka.jp\nmatsubara.osaka.jp\nminato.osaka.jp\nminoh.osaka.jp\nmisaki.osaka.jp\nmoriguchi.osaka.jp\nneyagawa.osaka.jp\nnishi.osaka.jp\nnose.osaka.jp\nosakasayama.osaka.jp\nsakai.osaka.jp\nsayama.osaka.jp\nsennan.osaka.jp\nsettsu.osaka.jp\nshijonawate.osaka.jp\nshimamoto.osaka.jp\nsuita.osaka.jp\ntadaoka.osaka.jp\ntaishi.osaka.jp\ntajiri.osaka.jp\ntakaishi.osaka.jp\ntakatsuki.osaka.jp\ntondabayashi.osaka.jp\ntoyonaka.osaka.jp\ntoyono.osaka.jp\nyao.osaka.jp\nariake.saga.jp\narita.saga.jp\nfukudomi.saga.jp\ngenkai.saga.jp\nhamatama.saga.jp\nhizen.saga.jp\nimari.saga.jp\nkamimine.saga.jp\nkanzaki.saga.jp\nkaratsu.saga.jp\nkashima.saga.jp\nkitagata.saga.jp\nkitahata.saga.jp\nkiyama.saga.jp\nkouhoku.saga.jp\nkyuragi.saga.jp\nnishiarita.saga.jp\nogi.saga.jp\nomachi.saga.jp\nouchi.saga.jp\nsaga.saga.jp\nshiroishi.saga.jp\ntaku.saga.jp\ntara.saga.jp\ntosu.saga.jp\nyoshinogari.saga.jp\narakawa.saitama.jp\nasaka.saitama.jp\nchichibu.saitama.jp\nfujimi.saitama.jp\nfujimino.saitama.jp\nfukaya.saitama.jp\nhanno.saitama.jp\nhanyu.saitama.jp\nhasuda.saitama.jp\nhatogaya.saitama.jp\nhatoyama.saitama.jp\nhidaka.saitama.jp\nhigashichichibu.saitama.jp\nhigashimatsuyama.saitama.jp\nhonjo.saitama.jp\nina.saitama.jp\niruma.saitama.jp\niwatsuki.saitama.jp\nkamiizumi.saitama.jp\nkamikawa.saitama.jp\nkamisato.saitama.jp\nkasukabe.saitama.jp\nkawagoe.saitama.jp\nkawaguchi.saitama.jp\nkawajima.saitama.jp\nkazo.saitama.jp\nkitamoto.saitama.jp\nkoshigaya.saitama.jp\nkounosu.saitama.jp\nkuki.saitama.jp\nkumagaya.saitama.jp\nmatsubushi.saitama.jp\nminano.saitama.jp\nmisato.saitama.jp\nmiyashiro.saitama.jp\nmiyoshi.saitama.jp\nmoroyama.saitama.jp\nnagatoro.saitama.jp\nnamegawa.saitama.jp\nniiza.saitama.jp\nogano.saitama.jp\nogawa.saitama.jp\nogose.saitama.jp\nokegawa.saitama.jp\nomiya.saitama.jp\notaki.saitama.jp\nranzan.saitama.jp\nryokami.saitama.jp\nsaitama.saitama.jp\nsakado.saitama.jp\nsatte.saitama.jp\nsayama.saitama.jp\nshiki.saitama.jp\nshiraoka.saitama.jp\nsoka.saitama.jp\nsugito.saitama.jp\ntoda.saitama.jp\ntokigawa.saitama.jp\ntokorozawa.saitama.jp\ntsurugashima.saitama.jp\nurawa.saitama.jp\nwarabi.saitama.jp\nyashio.saitama.jp\nyokoze.saitama.jp\nyono.saitama.jp\nyorii.saitama.jp\nyoshida.saitama.jp\nyoshikawa.saitama.jp\nyoshimi.saitama.jp\naisho.shiga.jp\ngamo.shiga.jp\nhigashiomi.shiga.jp\nhikone.shiga.jp\nkoka.shiga.jp\nkonan.shiga.jp\nkosei.shiga.jp\nkoto.shiga.jp\nkusatsu.shiga.jp\nmaibara.shiga.jp\nmoriyama.shiga.jp\nnagahama.shiga.jp\nnishiazai.shiga.jp\nnotogawa.shiga.jp\nomihachiman.shiga.jp\notsu.shiga.jp\nritto.shiga.jp\nryuoh.shiga.jp\ntakashima.shiga.jp\ntakatsuki.shiga.jp\ntorahime.shiga.jp\ntoyosato.shiga.jp\nyasu.shiga.jp\nakagi.shimane.jp\nama.shimane.jp\ngotsu.shimane.jp\nhamada.shimane.jp\nhigashiizumo.shimane.jp\nhikawa.shimane.jp\nhikimi.shimane.jp\nizumo.shimane.jp\nkakinoki.shimane.jp\nmasuda.shimane.jp\nmatsue.shimane.jp\nmisato.shimane.jp\nnishinoshima.shimane.jp\nohda.shimane.jp\nokinoshima.shimane.jp\nokuizumo.shimane.jp\nshimane.shimane.jp\ntamayu.shimane.jp\ntsuwano.shimane.jp\nunnan.shimane.jp\nyakumo.shimane.jp\nyasugi.shimane.jp\nyatsuka.shimane.jp\narai.shizuoka.jp\natami.shizuoka.jp\nfuji.shizuoka.jp\nfujieda.shizuoka.jp\nfujikawa.shizuoka.jp\nfujinomiya.shizuoka.jp\nfukuroi.shizuoka.jp\ngotemba.shizuoka.jp\nhaibara.shizuoka.jp\nhamamatsu.shizuoka.jp\nhigashiizu.shizuoka.jp\nito.shizuoka.jp\niwata.shizuoka.jp\nizu.shizuoka.jp\nizunokuni.shizuoka.jp\nkakegawa.shizuoka.jp\nkannami.shizuoka.jp\nkawanehon.shizuoka.jp\nkawazu.shizuoka.jp\nkikugawa.shizuoka.jp\nkosai.shizuoka.jp\nmakinohara.shizuoka.jp\nmatsuzaki.shizuoka.jp\nminamiizu.shizuoka.jp\nmishima.shizuoka.jp\nmorimachi.shizuoka.jp\nnishiizu.shizuoka.jp\nnumazu.shizuoka.jp\nomaezaki.shizuoka.jp\nshimada.shizuoka.jp\nshimizu.shizuoka.jp\nshimoda.shizuoka.jp\nshizuoka.shizuoka.jp\nsusono.shizuoka.jp\nyaizu.shizuoka.jp\nyoshida.shizuoka.jp\nashikaga.tochigi.jp\nbato.tochigi.jp\nhaga.tochigi.jp\nichikai.tochigi.jp\niwafune.tochigi.jp\nkaminokawa.tochigi.jp\nkanuma.tochigi.jp\nkarasuyama.tochigi.jp\nkuroiso.tochigi.jp\nmashiko.tochigi.jp\nmibu.tochigi.jp\nmoka.tochigi.jp\nmotegi.tochigi.jp\nnasu.tochigi.jp\nnasushiobara.tochigi.jp\nnikko.tochigi.jp\nnishikata.tochigi.jp\nnogi.tochigi.jp\nohira.tochigi.jp\nohtawara.tochigi.jp\noyama.tochigi.jp\nsakura.tochigi.jp\nsano.tochigi.jp\nshimotsuke.tochigi.jp\nshioya.tochigi.jp\ntakanezawa.tochigi.jp\ntochigi.tochigi.jp\ntsuga.tochigi.jp\nujiie.tochigi.jp\nutsunomiya.tochigi.jp\nyaita.tochigi.jp\naizumi.tokushima.jp\nanan.tokushima.jp\nichiba.tokushima.jp\nitano.tokushima.jp\nkainan.tokushima.jp\nkomatsushima.tokushima.jp\nmatsushige.tokushima.jp\nmima.tokushima.jp\nminami.tokushima.jp\nmiyoshi.tokushima.jp\nmugi.tokushima.jp\nnakagawa.tokushima.jp\nnaruto.tokushima.jp\nsanagochi.tokushima.jp\nshishikui.tokushima.jp\ntokushima.tokushima.jp\nwajiki.tokushima.jp\nadachi.tokyo.jp\nakiruno.tokyo.jp\nakishima.tokyo.jp\naogashima.tokyo.jp\narakawa.tokyo.jp\nbunkyo.tokyo.jp\nchiyoda.tokyo.jp\nchofu.tokyo.jp\nchuo.tokyo.jp\nedogawa.tokyo.jp\nfuchu.tokyo.jp\nfussa.tokyo.jp\nhachijo.tokyo.jp\nhachioji.tokyo.jp\nhamura.tokyo.jp\nhigashikurume.tokyo.jp\nhigashimurayama.tokyo.jp\nhigashiyamato.tokyo.jp\nhino.tokyo.jp\nhinode.tokyo.jp\nhinohara.tokyo.jp\ninagi.tokyo.jp\nitabashi.tokyo.jp\nkatsushika.tokyo.jp\nkita.tokyo.jp\nkiyose.tokyo.jp\nkodaira.tokyo.jp\nkoganei.tokyo.jp\nkokubunji.tokyo.jp\nkomae.tokyo.jp\nkoto.tokyo.jp\nkouzushima.tokyo.jp\nkunitachi.tokyo.jp\nmachida.tokyo.jp\nmeguro.tokyo.jp\nminato.tokyo.jp\nmitaka.tokyo.jp\nmizuho.tokyo.jp\nmusashimurayama.tokyo.jp\nmusashino.tokyo.jp\nnakano.tokyo.jp\nnerima.tokyo.jp\nogasawara.tokyo.jp\nokutama.tokyo.jp\nome.tokyo.jp\noshima.tokyo.jp\nota.tokyo.jp\nsetagaya.tokyo.jp\nshibuya.tokyo.jp\nshinagawa.tokyo.jp\nshinjuku.tokyo.jp\nsuginami.tokyo.jp\nsumida.tokyo.jp\ntachikawa.tokyo.jp\ntaito.tokyo.jp\ntama.tokyo.jp\ntoshima.tokyo.jp\nchizu.tottori.jp\nhino.tottori.jp\nkawahara.tottori.jp\nkoge.tottori.jp\nkotoura.tottori.jp\nmisasa.tottori.jp\nnanbu.tottori.jp\nnichinan.tottori.jp\nsakaiminato.tottori.jp\ntottori.tottori.jp\nwakasa.tottori.jp\nyazu.tottori.jp\nyonago.tottori.jp\nasahi.toyama.jp\nfuchu.toyama.jp\nfukumitsu.toyama.jp\nfunahashi.toyama.jp\nhimi.toyama.jp\nimizu.toyama.jp\ninami.toyama.jp\njohana.toyama.jp\nkamiichi.toyama.jp\nkurobe.toyama.jp\nnakaniikawa.toyama.jp\nnamerikawa.toyama.jp\nnanto.toyama.jp\nnyuzen.toyama.jp\noyabe.toyama.jp\ntaira.toyama.jp\ntakaoka.toyama.jp\ntateyama.toyama.jp\ntoga.toyama.jp\ntonami.toyama.jp\ntoyama.toyama.jp\nunazuki.toyama.jp\nuozu.toyama.jp\nyamada.toyama.jp\narida.wakayama.jp\naridagawa.wakayama.jp\ngobo.wakayama.jp\nhashimoto.wakayama.jp\nhidaka.wakayama.jp\nhirogawa.wakayama.jp\ninami.wakayama.jp\niwade.wakayama.jp\nkainan.wakayama.jp\nkamitonda.wakayama.jp\nkatsuragi.wakayama.jp\nkimino.wakayama.jp\nkinokawa.wakayama.jp\nkitayama.wakayama.jp\nkoya.wakayama.jp\nkoza.wakayama.jp\nkozagawa.wakayama.jp\nkudoyama.wakayama.jp\nkushimoto.wakayama.jp\nmihama.wakayama.jp\nmisato.wakayama.jp\nnachikatsuura.wakayama.jp\nshingu.wakayama.jp\nshirahama.wakayama.jp\ntaiji.wakayama.jp\ntanabe.wakayama.jp\nwakayama.wakayama.jp\nyuasa.wakayama.jp\nyura.wakayama.jp\nasahi.yamagata.jp\nfunagata.yamagata.jp\nhigashine.yamagata.jp\niide.yamagata.jp\nkahoku.yamagata.jp\nkaminoyama.yamagata.jp\nkaneyama.yamagata.jp\nkawanishi.yamagata.jp\nmamurogawa.yamagata.jp\nmikawa.yamagata.jp\nmurayama.yamagata.jp\nnagai.yamagata.jp\nnakayama.yamagata.jp\nnanyo.yamagata.jp\nnishikawa.yamagata.jp\nobanazawa.yamagata.jp\noe.yamagata.jp\noguni.yamagata.jp\nohkura.yamagata.jp\noishida.yamagata.jp\nsagae.yamagata.jp\nsakata.yamagata.jp\nsakegawa.yamagata.jp\nshinjo.yamagata.jp\nshirataka.yamagata.jp\nshonai.yamagata.jp\ntakahata.yamagata.jp\ntendo.yamagata.jp\ntozawa.yamagata.jp\ntsuruoka.yamagata.jp\nyamagata.yamagata.jp\nyamanobe.yamagata.jp\nyonezawa.yamagata.jp\nyuza.yamagata.jp\nabu.yamaguchi.jp\nhagi.yamaguchi.jp\nhikari.yamaguchi.jp\nhofu.yamaguchi.jp\niwakuni.yamaguchi.jp\nkudamatsu.yamaguchi.jp\nmitou.yamaguchi.jp\nnagato.yamaguchi.jp\noshima.yamaguchi.jp\nshimonoseki.yamaguchi.jp\nshunan.yamaguchi.jp\ntabuse.yamaguchi.jp\ntokuyama.yamaguchi.jp\ntoyota.yamaguchi.jp\nube.yamaguchi.jp\nyuu.yamaguchi.jp\nchuo.yamanashi.jp\ndoshi.yamanashi.jp\nfuefuki.yamanashi.jp\nfujikawa.yamanashi.jp\nfujikawaguchiko.yamanashi.jp\nfujiyoshida.yamanashi.jp\nhayakawa.yamanashi.jp\nhokuto.yamanashi.jp\nichikawamisato.yamanashi.jp\nkai.yamanashi.jp\nkofu.yamanashi.jp\nkoshu.yamanashi.jp\nkosuge.yamanashi.jp\nminami-alps.yamanashi.jp\nminobu.yamanashi.jp\nnakamichi.yamanashi.jp\nnanbu.yamanashi.jp\nnarusawa.yamanashi.jp\nnirasaki.yamanashi.jp\nnishikatsura.yamanashi.jp\noshino.yamanashi.jp\notsuki.yamanashi.jp\nshowa.yamanashi.jp\ntabayama.yamanashi.jp\ntsuru.yamanashi.jp\nuenohara.yamanashi.jp\nyamanakako.yamanashi.jp\nyamanashi.yamanashi.jp\nke\nac.ke\nco.ke\ngo.ke\ninfo.ke\nme.ke\nmobi.ke\nne.ke\nor.ke\nsc.ke\nkg\norg.kg\nnet.kg\ncom.kg\nedu.kg\ngov.kg\nmil.kg\n*.kh\nki\nedu.ki\nbiz.ki\nnet.ki\norg.ki\ngov.ki\ninfo.ki\ncom.ki\nkm\norg.km\nnom.km\ngov.km\nprd.km\ntm.km\nedu.km\nmil.km\nass.km\ncom.km\ncoop.km\nasso.km\npresse.km\nmedecin.km\nnotaires.km\npharmaciens.km\nveterinaire.km\ngouv.km\nkn\nnet.kn\norg.kn\nedu.kn\ngov.kn\nkp\ncom.kp\nedu.kp\ngov.kp\norg.kp\nrep.kp\ntra.kp\nkr\nac.kr\nco.kr\nes.kr\ngo.kr\nhs.kr\nkg.kr\nmil.kr\nms.kr\nne.kr\nor.kr\npe.kr\nre.kr\nsc.kr\nbusan.kr\nchungbuk.kr\nchungnam.kr\ndaegu.kr\ndaejeon.kr\ngangwon.kr\ngwangju.kr\ngyeongbuk.kr\ngyeonggi.kr\ngyeongnam.kr\nincheon.kr\njeju.kr\njeonbuk.kr\njeonnam.kr\nseoul.kr\nulsan.kr\nkw\ncom.kw\nedu.kw\nemb.kw\ngov.kw\nind.kw\nnet.kw\norg.kw\nky\ncom.ky\nedu.ky\nnet.ky\norg.ky\nkz\norg.kz\nedu.kz\nnet.kz\ngov.kz\nmil.kz\ncom.kz\nla\nint.la\nnet.la\ninfo.la\nedu.la\ngov.la\nper.la\ncom.la\norg.la\nlb\ncom.lb\nedu.lb\ngov.lb\nnet.lb\norg.lb\nlc\ncom.lc\nnet.lc\nco.lc\norg.lc\nedu.lc\ngov.lc\nli\nlk\ngov.lk\nsch.lk\nnet.lk\nint.lk\ncom.lk\norg.lk\nedu.lk\nngo.lk\nsoc.lk\nweb.lk\nltd.lk\nassn.lk\ngrp.lk\nhotel.lk\nac.lk\nlr\ncom.lr\nedu.lr\ngov.lr\norg.lr\nnet.lr\nls\nac.ls\nbiz.ls\nco.ls\nedu.ls\ngov.ls\ninfo.ls\nnet.ls\norg.ls\nsc.ls\nlt\ngov.lt\nlu\nlv\ncom.lv\nedu.lv\ngov.lv\norg.lv\nmil.lv\nid.lv\nnet.lv\nasn.lv\nconf.lv\nly\ncom.ly\nnet.ly\ngov.ly\nplc.ly\nedu.ly\nsch.ly\nmed.ly\norg.ly\nid.ly\nma\nco.ma\nnet.ma\ngov.ma\norg.ma\nac.ma\npress.ma\nmc\ntm.mc\nasso.mc\nmd\nme\nco.me\nnet.me\norg.me\nedu.me\nac.me\ngov.me\nits.me\npriv.me\nmg\norg.mg\nnom.mg\ngov.mg\nprd.mg\ntm.mg\nedu.mg\nmil.mg\ncom.mg\nco.mg\nmh\nmil\nmk\ncom.mk\norg.mk\nnet.mk\nedu.mk\ngov.mk\ninf.mk\nname.mk\nml\ncom.ml\nedu.ml\ngouv.ml\ngov.ml\nnet.ml\norg.ml\npresse.ml\n*.mm\nmn\ngov.mn\nedu.mn\norg.mn\nmo\ncom.mo\nnet.mo\norg.mo\nedu.mo\ngov.mo\nmobi\nmp\nmq\nmr\ngov.mr\nms\ncom.ms\nedu.ms\ngov.ms\nnet.ms\norg.ms\nmt\ncom.mt\nedu.mt\nnet.mt\norg.mt\nmu\ncom.mu\nnet.mu\norg.mu\ngov.mu\nac.mu\nco.mu\nor.mu\nmuseum\nmv\naero.mv\nbiz.mv\ncom.mv\ncoop.mv\nedu.mv\ngov.mv\ninfo.mv\nint.mv\nmil.mv\nmuseum.mv\nname.mv\nnet.mv\norg.mv\npro.mv\nmw\nac.mw\nbiz.mw\nco.mw\ncom.mw\ncoop.mw\nedu.mw\ngov.mw\nint.mw\nmuseum.mw\nnet.mw\norg.mw\nmx\ncom.mx\norg.mx\ngob.mx\nedu.mx\nnet.mx\nmy\nbiz.my\ncom.my\nedu.my\ngov.my\nmil.my\nname.my\nnet.my\norg.my\nmz\nac.mz\nadv.mz\nco.mz\nedu.mz\ngov.mz\nmil.mz\nnet.mz\norg.mz\nna\ninfo.na\npro.na\nname.na\nschool.na\nor.na\ndr.na\nus.na\nmx.na\nca.na\nin.na\ncc.na\ntv.na\nws.na\nmobi.na\nco.na\ncom.na\norg.na\nname\nnc\nasso.nc\nnom.nc\nne\nnet\nnf\ncom.nf\nnet.nf\nper.nf\nrec.nf\nweb.nf\narts.nf\nfirm.nf\ninfo.nf\nother.nf\nstore.nf\nng\ncom.ng\nedu.ng\ngov.ng\ni.ng\nmil.ng\nmobi.ng\nname.ng\nnet.ng\norg.ng\nsch.ng\nni\nac.ni\nbiz.ni\nco.ni\ncom.ni\nedu.ni\ngob.ni\nin.ni\ninfo.ni\nint.ni\nmil.ni\nnet.ni\nnom.ni\norg.ni\nweb.ni\nnl\nno\nfhs.no\nvgs.no\nfylkesbibl.no\nfolkebibl.no\nmuseum.no\nidrett.no\npriv.no\nmil.no\nstat.no\ndep.no\nkommune.no\nherad.no\naa.no\nah.no\nbu.no\nfm.no\nhl.no\nhm.no\njan-mayen.no\nmr.no\nnl.no\nnt.no\nof.no\nol.no\noslo.no\nrl.no\nsf.no\nst.no\nsvalbard.no\ntm.no\ntr.no\nva.no\nvf.no\ngs.aa.no\ngs.ah.no\ngs.bu.no\ngs.fm.no\ngs.hl.no\ngs.hm.no\ngs.jan-mayen.no\ngs.mr.no\ngs.nl.no\ngs.nt.no\ngs.of.no\ngs.ol.no\ngs.oslo.no\ngs.rl.no\ngs.sf.no\ngs.st.no\ngs.svalbard.no\ngs.tm.no\ngs.tr.no\ngs.va.no\ngs.vf.no\nakrehamn.no\nxn--krehamn-dxa.no\nalgard.no\nxn--lgrd-poac.no\narna.no\nbrumunddal.no\nbryne.no\nbronnoysund.no\nxn--brnnysund-m8ac.no\ndrobak.no\nxn--drbak-wua.no\negersund.no\nfetsund.no\nfloro.no\nxn--flor-jra.no\nfredrikstad.no\nhokksund.no\nhonefoss.no\nxn--hnefoss-q1a.no\njessheim.no\njorpeland.no\nxn--jrpeland-54a.no\nkirkenes.no\nkopervik.no\nkrokstadelva.no\nlangevag.no\nxn--langevg-jxa.no\nleirvik.no\nmjondalen.no\nxn--mjndalen-64a.no\nmo-i-rana.no\nmosjoen.no\nxn--mosjen-eya.no\nnesoddtangen.no\norkanger.no\nosoyro.no\nxn--osyro-wua.no\nraholt.no\nxn--rholt-mra.no\nsandnessjoen.no\nxn--sandnessjen-ogb.no\nskedsmokorset.no\nslattum.no\nspjelkavik.no\nstathelle.no\nstavern.no\nstjordalshalsen.no\nxn--stjrdalshalsen-sqb.no\ntananger.no\ntranby.no\nvossevangen.no\nafjord.no\nxn--fjord-lra.no\nagdenes.no\nal.no\nxn--l-1fa.no\nalesund.no\nxn--lesund-hua.no\nalstahaug.no\nalta.no\nxn--lt-liac.no\nalaheadju.no\nxn--laheadju-7ya.no\nalvdal.no\namli.no\nxn--mli-tla.no\namot.no\nxn--mot-tla.no\nandebu.no\nandoy.no\nxn--andy-ira.no\nandasuolo.no\nardal.no\nxn--rdal-poa.no\naremark.no\narendal.no\nxn--s-1fa.no\naseral.no\nxn--seral-lra.no\nasker.no\naskim.no\naskvoll.no\naskoy.no\nxn--asky-ira.no\nasnes.no\nxn--snes-poa.no\naudnedaln.no\naukra.no\naure.no\naurland.no\naurskog-holand.no\nxn--aurskog-hland-jnb.no\naustevoll.no\naustrheim.no\naveroy.no\nxn--avery-yua.no\nbalestrand.no\nballangen.no\nbalat.no\nxn--blt-elab.no\nbalsfjord.no\nbahccavuotna.no\nxn--bhccavuotna-k7a.no\nbamble.no\nbardu.no\nbeardu.no\nbeiarn.no\nbajddar.no\nxn--bjddar-pta.no\nbaidar.no\nxn--bidr-5nac.no\nberg.no\nbergen.no\nberlevag.no\nxn--berlevg-jxa.no\nbearalvahki.no\nxn--bearalvhki-y4a.no\nbindal.no\nbirkenes.no\nbjarkoy.no\nxn--bjarky-fya.no\nbjerkreim.no\nbjugn.no\nbodo.no\nxn--bod-2na.no\nbadaddja.no\nxn--bdddj-mrabd.no\nbudejju.no\nbokn.no\nbremanger.no\nbronnoy.no\nxn--brnny-wuac.no\nbygland.no\nbykle.no\nbarum.no\nxn--brum-voa.no\nbo.telemark.no\nxn--b-5ga.telemark.no\nbo.nordland.no\nxn--b-5ga.nordland.no\nbievat.no\nxn--bievt-0qa.no\nbomlo.no\nxn--bmlo-gra.no\nbatsfjord.no\nxn--btsfjord-9za.no\nbahcavuotna.no\nxn--bhcavuotna-s4a.no\ndovre.no\ndrammen.no\ndrangedal.no\ndyroy.no\nxn--dyry-ira.no\ndonna.no\nxn--dnna-gra.no\neid.no\neidfjord.no\neidsberg.no\neidskog.no\neidsvoll.no\neigersund.no\nelverum.no\nenebakk.no\nengerdal.no\netne.no\netnedal.no\nevenes.no\nevenassi.no\nxn--eveni-0qa01ga.no\nevje-og-hornnes.no\nfarsund.no\nfauske.no\nfuossko.no\nfuoisku.no\nfedje.no\nfet.no\nfinnoy.no\nxn--finny-yua.no\nfitjar.no\nfjaler.no\nfjell.no\nflakstad.no\nflatanger.no\nflekkefjord.no\nflesberg.no\nflora.no\nfla.no\nxn--fl-zia.no\nfolldal.no\nforsand.no\nfosnes.no\nfrei.no\nfrogn.no\nfroland.no\nfrosta.no\nfrana.no\nxn--frna-woa.no\nfroya.no\nxn--frya-hra.no\nfusa.no\nfyresdal.no\nforde.no\nxn--frde-gra.no\ngamvik.no\ngangaviika.no\nxn--ggaviika-8ya47h.no\ngaular.no\ngausdal.no\ngildeskal.no\nxn--gildeskl-g0a.no\ngiske.no\ngjemnes.no\ngjerdrum.no\ngjerstad.no\ngjesdal.no\ngjovik.no\nxn--gjvik-wua.no\ngloppen.no\ngol.no\ngran.no\ngrane.no\ngranvin.no\ngratangen.no\ngrimstad.no\ngrong.no\nkraanghke.no\nxn--kranghke-b0a.no\ngrue.no\ngulen.no\nhadsel.no\nhalden.no\nhalsa.no\nhamar.no\nhamaroy.no\nhabmer.no\nxn--hbmer-xqa.no\nhapmir.no\nxn--hpmir-xqa.no\nhammerfest.no\nhammarfeasta.no\nxn--hmmrfeasta-s4ac.no\nharam.no\nhareid.no\nharstad.no\nhasvik.no\naknoluokta.no\nxn--koluokta-7ya57h.no\nhattfjelldal.no\naarborte.no\nhaugesund.no\nhemne.no\nhemnes.no\nhemsedal.no\nheroy.more-og-romsdal.no\nxn--hery-ira.xn--mre-og-romsdal-qqb.no\nheroy.nordland.no\nxn--hery-ira.nordland.no\nhitra.no\nhjartdal.no\nhjelmeland.no\nhobol.no\nxn--hobl-ira.no\nhof.no\nhol.no\nhole.no\nholmestrand.no\nholtalen.no\nxn--holtlen-hxa.no\nhornindal.no\nhorten.no\nhurdal.no\nhurum.no\nhvaler.no\nhyllestad.no\nhagebostad.no\nxn--hgebostad-g3a.no\nhoyanger.no\nxn--hyanger-q1a.no\nhoylandet.no\nxn--hylandet-54a.no\nha.no\nxn--h-2fa.no\nibestad.no\ninderoy.no\nxn--indery-fya.no\niveland.no\njevnaker.no\njondal.no\njolster.no\nxn--jlster-bya.no\nkarasjok.no\nkarasjohka.no\nxn--krjohka-hwab49j.no\nkarlsoy.no\ngalsa.no\nxn--gls-elac.no\nkarmoy.no\nxn--karmy-yua.no\nkautokeino.no\nguovdageaidnu.no\nklepp.no\nklabu.no\nxn--klbu-woa.no\nkongsberg.no\nkongsvinger.no\nkragero.no\nxn--krager-gya.no\nkristiansand.no\nkristiansund.no\nkrodsherad.no\nxn--krdsherad-m8a.no\nkvalsund.no\nrahkkeravju.no\nxn--rhkkervju-01af.no\nkvam.no\nkvinesdal.no\nkvinnherad.no\nkviteseid.no\nkvitsoy.no\nxn--kvitsy-fya.no\nkvafjord.no\nxn--kvfjord-nxa.no\ngiehtavuoatna.no\nkvanangen.no\nxn--kvnangen-k0a.no\nnavuotna.no\nxn--nvuotna-hwa.no\nkafjord.no\nxn--kfjord-iua.no\ngaivuotna.no\nxn--givuotna-8ya.no\nlarvik.no\nlavangen.no\nlavagis.no\nloabat.no\nxn--loabt-0qa.no\nlebesby.no\ndavvesiida.no\nleikanger.no\nleirfjord.no\nleka.no\nleksvik.no\nlenvik.no\nleangaviika.no\nxn--leagaviika-52b.no\nlesja.no\nlevanger.no\nlier.no\nlierne.no\nlillehammer.no\nlillesand.no\nlindesnes.no\nlindas.no\nxn--linds-pra.no\nlom.no\nloppa.no\nlahppi.no\nxn--lhppi-xqa.no\nlund.no\nlunner.no\nluroy.no\nxn--lury-ira.no\nluster.no\nlyngdal.no\nlyngen.no\nivgu.no\nlardal.no\nlerdal.no\nxn--lrdal-sra.no\nlodingen.no\nxn--ldingen-q1a.no\nlorenskog.no\nxn--lrenskog-54a.no\nloten.no\nxn--lten-gra.no\nmalvik.no\nmasoy.no\nxn--msy-ula0h.no\nmuosat.no\nxn--muost-0qa.no\nmandal.no\nmarker.no\nmarnardal.no\nmasfjorden.no\nmeland.no\nmeldal.no\nmelhus.no\nmeloy.no\nxn--mely-ira.no\nmeraker.no\nxn--merker-kua.no\nmoareke.no\nxn--moreke-jua.no\nmidsund.no\nmidtre-gauldal.no\nmodalen.no\nmodum.no\nmolde.no\nmoskenes.no\nmoss.no\nmosvik.no\nmalselv.no\nxn--mlselv-iua.no\nmalatvuopmi.no\nxn--mlatvuopmi-s4a.no\nnamdalseid.no\naejrie.no\nnamsos.no\nnamsskogan.no\nnaamesjevuemie.no\nxn--nmesjevuemie-tcba.no\nlaakesvuemie.no\nnannestad.no\nnarvik.no\nnarviika.no\nnaustdal.no\nnedre-eiker.no\nnes.akershus.no\nnes.buskerud.no\nnesna.no\nnesodden.no\nnesseby.no\nunjarga.no\nxn--unjrga-rta.no\nnesset.no\nnissedal.no\nnittedal.no\nnord-aurdal.no\nnord-fron.no\nnord-odal.no\nnorddal.no\nnordkapp.no\ndavvenjarga.no\nxn--davvenjrga-y4a.no\nnordre-land.no\nnordreisa.no\nraisa.no\nxn--risa-5na.no\nnore-og-uvdal.no\nnotodden.no\nnaroy.no\nxn--nry-yla5g.no\nnotteroy.no\nxn--nttery-byae.no\nodda.no\noksnes.no\nxn--ksnes-uua.no\noppdal.no\noppegard.no\nxn--oppegrd-ixa.no\norkdal.no\norland.no\nxn--rland-uua.no\norskog.no\nxn--rskog-uua.no\norsta.no\nxn--rsta-fra.no\nos.hedmark.no\nos.hordaland.no\nosen.no\nosteroy.no\nxn--ostery-fya.no\nostre-toten.no\nxn--stre-toten-zcb.no\noverhalla.no\novre-eiker.no\nxn--vre-eiker-k8a.no\noyer.no\nxn--yer-zna.no\noygarden.no\nxn--ygarden-p1a.no\noystre-slidre.no\nxn--ystre-slidre-ujb.no\nporsanger.no\nporsangu.no\nxn--porsgu-sta26f.no\nporsgrunn.no\nradoy.no\nxn--rady-ira.no\nrakkestad.no\nrana.no\nruovat.no\nrandaberg.no\nrauma.no\nrendalen.no\nrennebu.no\nrennesoy.no\nxn--rennesy-v1a.no\nrindal.no\nringebu.no\nringerike.no\nringsaker.no\nrissa.no\nrisor.no\nxn--risr-ira.no\nroan.no\nrollag.no\nrygge.no\nralingen.no\nxn--rlingen-mxa.no\nrodoy.no\nxn--rdy-0nab.no\nromskog.no\nxn--rmskog-bya.no\nroros.no\nxn--rros-gra.no\nrost.no\nxn--rst-0na.no\nroyken.no\nxn--ryken-vua.no\nroyrvik.no\nxn--ryrvik-bya.no\nrade.no\nxn--rde-ula.no\nsalangen.no\nsiellak.no\nsaltdal.no\nsalat.no\nxn--slt-elab.no\nxn--slat-5na.no\nsamnanger.no\nsande.more-og-romsdal.no\nsande.xn--mre-og-romsdal-qqb.no\nsande.vestfold.no\nsandefjord.no\nsandnes.no\nsandoy.no\nxn--sandy-yua.no\nsarpsborg.no\nsauda.no\nsauherad.no\nsel.no\nselbu.no\nselje.no\nseljord.no\nsigdal.no\nsiljan.no\nsirdal.no\nskaun.no\nskedsmo.no\nski.no\nskien.no\nskiptvet.no\nskjervoy.no\nxn--skjervy-v1a.no\nskierva.no\nxn--skierv-uta.no\nskjak.no\nxn--skjk-soa.no\nskodje.no\nskanland.no\nxn--sknland-fxa.no\nskanit.no\nxn--sknit-yqa.no\nsmola.no\nxn--smla-hra.no\nsnillfjord.no\nsnasa.no\nxn--snsa-roa.no\nsnoasa.no\nsnaase.no\nxn--snase-nra.no\nsogndal.no\nsokndal.no\nsola.no\nsolund.no\nsongdalen.no\nsortland.no\nspydeberg.no\nstange.no\nstavanger.no\nsteigen.no\nsteinkjer.no\nstjordal.no\nxn--stjrdal-s1a.no\nstokke.no\nstor-elvdal.no\nstord.no\nstordal.no\nstorfjord.no\nomasvuotna.no\nstrand.no\nstranda.no\nstryn.no\nsula.no\nsuldal.no\nsund.no\nsunndal.no\nsurnadal.no\nsveio.no\nsvelvik.no\nsykkylven.no\nsogne.no\nxn--sgne-gra.no\nsomna.no\nxn--smna-gra.no\nsondre-land.no\nxn--sndre-land-0cb.no\nsor-aurdal.no\nxn--sr-aurdal-l8a.no\nsor-fron.no\nxn--sr-fron-q1a.no\nsor-odal.no\nxn--sr-odal-q1a.no\nsor-varanger.no\nxn--sr-varanger-ggb.no\nmatta-varjjat.no\nxn--mtta-vrjjat-k7af.no\nsorfold.no\nxn--srfold-bya.no\nsorreisa.no\nxn--srreisa-q1a.no\nsorum.no\nxn--srum-gra.no\ntana.no\ndeatnu.no\ntime.no\ntingvoll.no\ntinn.no\ntjeldsund.no\ndielddanuorri.no\ntjome.no\nxn--tjme-hra.no\ntokke.no\ntolga.no\ntorsken.no\ntranoy.no\nxn--trany-yua.no\ntromso.no\nxn--troms-zua.no\ntromsa.no\nromsa.no\ntrondheim.no\ntroandin.no\ntrysil.no\ntrana.no\nxn--trna-woa.no\ntrogstad.no\nxn--trgstad-r1a.no\ntvedestrand.no\ntydal.no\ntynset.no\ntysfjord.no\ndivtasvuodna.no\ndivttasvuotna.no\ntysnes.no\ntysvar.no\nxn--tysvr-vra.no\ntonsberg.no\nxn--tnsberg-q1a.no\nullensaker.no\nullensvang.no\nulvik.no\nutsira.no\nvadso.no\nxn--vads-jra.no\ncahcesuolo.no\nxn--hcesuolo-7ya35b.no\nvaksdal.no\nvalle.no\nvang.no\nvanylven.no\nvardo.no\nxn--vard-jra.no\nvarggat.no\nxn--vrggt-xqad.no\nvefsn.no\nvaapste.no\nvega.no\nvegarshei.no\nxn--vegrshei-c0a.no\nvennesla.no\nverdal.no\nverran.no\nvestby.no\nvestnes.no\nvestre-slidre.no\nvestre-toten.no\nvestvagoy.no\nxn--vestvgy-ixa6o.no\nvevelstad.no\nvik.no\nvikna.no\nvindafjord.no\nvolda.no\nvoss.no\nvaroy.no\nxn--vry-yla5g.no\nvagan.no\nxn--vgan-qoa.no\nvoagat.no\nvagsoy.no\nxn--vgsy-qoa0j.no\nvaga.no\nxn--vg-yiab.no\nvaler.ostfold.no\nxn--vler-qoa.xn--stfold-9xa.no\nvaler.hedmark.no\nxn--vler-qoa.hedmark.no\n*.np\nnr\nbiz.nr\ninfo.nr\ngov.nr\nedu.nr\norg.nr\nnet.nr\ncom.nr\nnu\nnz\nac.nz\nco.nz\ncri.nz\ngeek.nz\ngen.nz\ngovt.nz\nhealth.nz\niwi.nz\nkiwi.nz\nmaori.nz\nmil.nz\nxn--mori-qsa.nz\nnet.nz\norg.nz\nparliament.nz\nschool.nz\nom\nco.om\ncom.om\nedu.om\ngov.om\nmed.om\nmuseum.om\nnet.om\norg.om\npro.om\nonion\norg\npa\nac.pa\ngob.pa\ncom.pa\norg.pa\nsld.pa\nedu.pa\nnet.pa\ning.pa\nabo.pa\nmed.pa\nnom.pa\npe\nedu.pe\ngob.pe\nnom.pe\nmil.pe\norg.pe\ncom.pe\nnet.pe\npf\ncom.pf\norg.pf\nedu.pf\n*.pg\nph\ncom.ph\nnet.ph\norg.ph\ngov.ph\nedu.ph\nngo.ph\nmil.ph\ni.ph\npk\ncom.pk\nnet.pk\nedu.pk\norg.pk\nfam.pk\nbiz.pk\nweb.pk\ngov.pk\ngob.pk\ngok.pk\ngon.pk\ngop.pk\ngos.pk\ninfo.pk\npl\ncom.pl\nnet.pl\norg.pl\naid.pl\nagro.pl\natm.pl\nauto.pl\nbiz.pl\nedu.pl\ngmina.pl\ngsm.pl\ninfo.pl\nmail.pl\nmiasta.pl\nmedia.pl\nmil.pl\nnieruchomosci.pl\nnom.pl\npc.pl\npowiat.pl\npriv.pl\nrealestate.pl\nrel.pl\nsex.pl\nshop.pl\nsklep.pl\nsos.pl\nszkola.pl\ntargi.pl\ntm.pl\ntourism.pl\ntravel.pl\nturystyka.pl\ngov.pl\nap.gov.pl\ngriw.gov.pl\nic.gov.pl\nis.gov.pl\nkmpsp.gov.pl\nkonsulat.gov.pl\nkppsp.gov.pl\nkwp.gov.pl\nkwpsp.gov.pl\nmup.gov.pl\nmw.gov.pl\noia.gov.pl\noirm.gov.pl\noke.gov.pl\noow.gov.pl\noschr.gov.pl\noum.gov.pl\npa.gov.pl\npinb.gov.pl\npiw.gov.pl\npo.gov.pl\npr.gov.pl\npsp.gov.pl\npsse.gov.pl\npup.gov.pl\nrzgw.gov.pl\nsa.gov.pl\nsdn.gov.pl\nsko.gov.pl\nso.gov.pl\nsr.gov.pl\nstarostwo.gov.pl\nug.gov.pl\nugim.gov.pl\num.gov.pl\numig.gov.pl\nupow.gov.pl\nuppo.gov.pl\nus.gov.pl\nuw.gov.pl\nuzs.gov.pl\nwif.gov.pl\nwiih.gov.pl\nwinb.gov.pl\nwios.gov.pl\nwitd.gov.pl\nwiw.gov.pl\nwkz.gov.pl\nwsa.gov.pl\nwskr.gov.pl\nwsse.gov.pl\nwuoz.gov.pl\nwzmiuw.gov.pl\nzp.gov.pl\nzpisdn.gov.pl\naugustow.pl\nbabia-gora.pl\nbedzin.pl\nbeskidy.pl\nbialowieza.pl\nbialystok.pl\nbielawa.pl\nbieszczady.pl\nboleslawiec.pl\nbydgoszcz.pl\nbytom.pl\ncieszyn.pl\nczeladz.pl\nczest.pl\ndlugoleka.pl\nelblag.pl\nelk.pl\nglogow.pl\ngniezno.pl\ngorlice.pl\ngrajewo.pl\nilawa.pl\njaworzno.pl\njelenia-gora.pl\njgora.pl\nkalisz.pl\nkazimierz-dolny.pl\nkarpacz.pl\nkartuzy.pl\nkaszuby.pl\nkatowice.pl\nkepno.pl\nketrzyn.pl\nklodzko.pl\nkobierzyce.pl\nkolobrzeg.pl\nkonin.pl\nkonskowola.pl\nkutno.pl\nlapy.pl\nlebork.pl\nlegnica.pl\nlezajsk.pl\nlimanowa.pl\nlomza.pl\nlowicz.pl\nlubin.pl\nlukow.pl\nmalbork.pl\nmalopolska.pl\nmazowsze.pl\nmazury.pl\nmielec.pl\nmielno.pl\nmragowo.pl\nnaklo.pl\nnowaruda.pl\nnysa.pl\nolawa.pl\nolecko.pl\nolkusz.pl\nolsztyn.pl\nopoczno.pl\nopole.pl\nostroda.pl\nostroleka.pl\nostrowiec.pl\nostrowwlkp.pl\npila.pl\npisz.pl\npodhale.pl\npodlasie.pl\npolkowice.pl\npomorze.pl\npomorskie.pl\nprochowice.pl\npruszkow.pl\nprzeworsk.pl\npulawy.pl\nradom.pl\nrawa-maz.pl\nrybnik.pl\nrzeszow.pl\nsanok.pl\nsejny.pl\nslask.pl\nslupsk.pl\nsosnowiec.pl\nstalowa-wola.pl\nskoczow.pl\nstarachowice.pl\nstargard.pl\nsuwalki.pl\nswidnica.pl\nswiebodzin.pl\nswinoujscie.pl\nszczecin.pl\nszczytno.pl\ntarnobrzeg.pl\ntgory.pl\nturek.pl\ntychy.pl\nustka.pl\nwalbrzych.pl\nwarmia.pl\nwarszawa.pl\nwaw.pl\nwegrow.pl\nwielun.pl\nwlocl.pl\nwloclawek.pl\nwodzislaw.pl\nwolomin.pl\nwroclaw.pl\nzachpomor.pl\nzagan.pl\nzarow.pl\nzgora.pl\nzgorzelec.pl\npm\npn\ngov.pn\nco.pn\norg.pn\nedu.pn\nnet.pn\npost\npr\ncom.pr\nnet.pr\norg.pr\ngov.pr\nedu.pr\nisla.pr\npro.pr\nbiz.pr\ninfo.pr\nname.pr\nest.pr\nprof.pr\nac.pr\npro\naaa.pro\naca.pro\nacct.pro\navocat.pro\nbar.pro\ncpa.pro\neng.pro\njur.pro\nlaw.pro\nmed.pro\nrecht.pro\nps\nedu.ps\ngov.ps\nsec.ps\nplo.ps\ncom.ps\norg.ps\nnet.ps\npt\nnet.pt\ngov.pt\norg.pt\nedu.pt\nint.pt\npubl.pt\ncom.pt\nnome.pt\npw\nco.pw\nne.pw\nor.pw\ned.pw\ngo.pw\nbelau.pw\npy\ncom.py\ncoop.py\nedu.py\ngov.py\nmil.py\nnet.py\norg.py\nqa\ncom.qa\nedu.qa\ngov.qa\nmil.qa\nname.qa\nnet.qa\norg.qa\nsch.qa\nre\nasso.re\ncom.re\nnom.re\nro\narts.ro\ncom.ro\nfirm.ro\ninfo.ro\nnom.ro\nnt.ro\norg.ro\nrec.ro\nstore.ro\ntm.ro\nwww.ro\nrs\nac.rs\nco.rs\nedu.rs\ngov.rs\nin.rs\norg.rs\nru\nrw\nac.rw\nco.rw\ncoop.rw\ngov.rw\nmil.rw\nnet.rw\norg.rw\nsa\ncom.sa\nnet.sa\norg.sa\ngov.sa\nmed.sa\npub.sa\nedu.sa\nsch.sa\nsb\ncom.sb\nedu.sb\ngov.sb\nnet.sb\norg.sb\nsc\ncom.sc\ngov.sc\nnet.sc\norg.sc\nedu.sc\nsd\ncom.sd\nnet.sd\norg.sd\nedu.sd\nmed.sd\ntv.sd\ngov.sd\ninfo.sd\nse\na.se\nac.se\nb.se\nbd.se\nbrand.se\nc.se\nd.se\ne.se\nf.se\nfh.se\nfhsk.se\nfhv.se\ng.se\nh.se\ni.se\nk.se\nkomforb.se\nkommunalforbund.se\nkomvux.se\nl.se\nlanbib.se\nm.se\nn.se\nnaturbruksgymn.se\no.se\norg.se\np.se\nparti.se\npp.se\npress.se\nr.se\ns.se\nt.se\ntm.se\nu.se\nw.se\nx.se\ny.se\nz.se\nsg\ncom.sg\nnet.sg\norg.sg\ngov.sg\nedu.sg\nper.sg\nsh\ncom.sh\nnet.sh\ngov.sh\norg.sh\nmil.sh\nsi\nsj\nsk\nsl\ncom.sl\nnet.sl\nedu.sl\ngov.sl\norg.sl\nsm\nsn\nart.sn\ncom.sn\nedu.sn\ngouv.sn\norg.sn\nperso.sn\nuniv.sn\nso\ncom.so\nedu.so\ngov.so\nme.so\nnet.so\norg.so\nsr\nss\nbiz.ss\ncom.ss\nedu.ss\ngov.ss\nme.ss\nnet.ss\norg.ss\nsch.ss\nst\nco.st\ncom.st\nconsulado.st\nedu.st\nembaixada.st\nmil.st\nnet.st\norg.st\nprincipe.st\nsaotome.st\nstore.st\nsu\nsv\ncom.sv\nedu.sv\ngob.sv\norg.sv\nred.sv\nsx\ngov.sx\nsy\nedu.sy\ngov.sy\nnet.sy\nmil.sy\ncom.sy\norg.sy\nsz\nco.sz\nac.sz\norg.sz\ntc\ntd\ntel\ntf\ntg\nth\nac.th\nco.th\ngo.th\nin.th\nmi.th\nnet.th\nor.th\ntj\nac.tj\nbiz.tj\nco.tj\ncom.tj\nedu.tj\ngo.tj\ngov.tj\nint.tj\nmil.tj\nname.tj\nnet.tj\nnic.tj\norg.tj\ntest.tj\nweb.tj\ntk\ntl\ngov.tl\ntm\ncom.tm\nco.tm\norg.tm\nnet.tm\nnom.tm\ngov.tm\nmil.tm\nedu.tm\ntn\ncom.tn\nens.tn\nfin.tn\ngov.tn\nind.tn\ninfo.tn\nintl.tn\nmincom.tn\nnat.tn\nnet.tn\norg.tn\nperso.tn\ntourism.tn\nto\ncom.to\ngov.to\nnet.to\norg.to\nedu.to\nmil.to\ntr\nav.tr\nbbs.tr\nbel.tr\nbiz.tr\ncom.tr\ndr.tr\nedu.tr\ngen.tr\ngov.tr\ninfo.tr\nmil.tr\nk12.tr\nkep.tr\nname.tr\nnet.tr\norg.tr\npol.tr\ntel.tr\ntsk.tr\ntv.tr\nweb.tr\nnc.tr\ngov.nc.tr\ntt\nco.tt\ncom.tt\norg.tt\nnet.tt\nbiz.tt\ninfo.tt\npro.tt\nint.tt\ncoop.tt\njobs.tt\nmobi.tt\ntravel.tt\nmuseum.tt\naero.tt\nname.tt\ngov.tt\nedu.tt\ntv\ntw\nedu.tw\ngov.tw\nmil.tw\ncom.tw\nnet.tw\norg.tw\nidv.tw\ngame.tw\nebiz.tw\nclub.tw\nxn--zf0ao64a.tw\nxn--uc0atv.tw\nxn--czrw28b.tw\ntz\nac.tz\nco.tz\ngo.tz\nhotel.tz\ninfo.tz\nme.tz\nmil.tz\nmobi.tz\nne.tz\nor.tz\nsc.tz\ntv.tz\nua\ncom.ua\nedu.ua\ngov.ua\nin.ua\nnet.ua\norg.ua\ncherkassy.ua\ncherkasy.ua\nchernigov.ua\nchernihiv.ua\nchernivtsi.ua\nchernovtsy.ua\nck.ua\ncn.ua\ncr.ua\ncrimea.ua\ncv.ua\ndn.ua\ndnepropetrovsk.ua\ndnipropetrovsk.ua\ndonetsk.ua\ndp.ua\nif.ua\nivano-frankivsk.ua\nkh.ua\nkharkiv.ua\nkharkov.ua\nkherson.ua\nkhmelnitskiy.ua\nkhmelnytskyi.ua\nkiev.ua\nkirovograd.ua\nkm.ua\nkr.ua\nkropyvnytskyi.ua\nkrym.ua\nks.ua\nkv.ua\nkyiv.ua\nlg.ua\nlt.ua\nlugansk.ua\nluhansk.ua\nlutsk.ua\nlv.ua\nlviv.ua\nmk.ua\nmykolaiv.ua\nnikolaev.ua\nod.ua\nodesa.ua\nodessa.ua\npl.ua\npoltava.ua\nrivne.ua\nrovno.ua\nrv.ua\nsb.ua\nsebastopol.ua\nsevastopol.ua\nsm.ua\nsumy.ua\nte.ua\nternopil.ua\nuz.ua\nuzhgorod.ua\nuzhhorod.ua\nvinnica.ua\nvinnytsia.ua\nvn.ua\nvolyn.ua\nyalta.ua\nzakarpattia.ua\nzaporizhzhe.ua\nzaporizhzhia.ua\nzhitomir.ua\nzhytomyr.ua\nzp.ua\nzt.ua\nug\nco.ug\nor.ug\nac.ug\nsc.ug\ngo.ug\nne.ug\ncom.ug\norg.ug\nuk\nac.uk\nco.uk\ngov.uk\nltd.uk\nme.uk\nnet.uk\nnhs.uk\norg.uk\nplc.uk\npolice.uk\n*.sch.uk\nus\ndni.us\nfed.us\nisa.us\nkids.us\nnsn.us\nak.us\nal.us\nar.us\nas.us\naz.us\nca.us\nco.us\nct.us\ndc.us\nde.us\nfl.us\nga.us\ngu.us\nhi.us\nia.us\nid.us\nil.us\nin.us\nks.us\nky.us\nla.us\nma.us\nmd.us\nme.us\nmi.us\nmn.us\nmo.us\nms.us\nmt.us\nnc.us\nnd.us\nne.us\nnh.us\nnj.us\nnm.us\nnv.us\nny.us\noh.us\nok.us\nor.us\npa.us\npr.us\nri.us\nsc.us\nsd.us\ntn.us\ntx.us\nut.us\nvi.us\nvt.us\nva.us\nwa.us\nwi.us\nwv.us\nwy.us\nk12.ak.us\nk12.al.us\nk12.ar.us\nk12.as.us\nk12.az.us\nk12.ca.us\nk12.co.us\nk12.ct.us\nk12.dc.us\nk12.fl.us\nk12.ga.us\nk12.gu.us\nk12.ia.us\nk12.id.us\nk12.il.us\nk12.in.us\nk12.ks.us\nk12.ky.us\nk12.la.us\nk12.ma.us\nk12.md.us\nk12.me.us\nk12.mi.us\nk12.mn.us\nk12.mo.us\nk12.ms.us\nk12.mt.us\nk12.nc.us\nk12.ne.us\nk12.nh.us\nk12.nj.us\nk12.nm.us\nk12.nv.us\nk12.ny.us\nk12.oh.us\nk12.ok.us\nk12.or.us\nk12.pa.us\nk12.pr.us\nk12.sc.us\nk12.tn.us\nk12.tx.us\nk12.ut.us\nk12.vi.us\nk12.vt.us\nk12.va.us\nk12.wa.us\nk12.wi.us\nk12.wy.us\ncc.ak.us\ncc.al.us\ncc.ar.us\ncc.as.us\ncc.az.us\ncc.ca.us\ncc.co.us\ncc.ct.us\ncc.dc.us\ncc.de.us\ncc.fl.us\ncc.ga.us\ncc.gu.us\ncc.hi.us\ncc.ia.us\ncc.id.us\ncc.il.us\ncc.in.us\ncc.ks.us\ncc.ky.us\ncc.la.us\ncc.ma.us\ncc.md.us\ncc.me.us\ncc.mi.us\ncc.mn.us\ncc.mo.us\ncc.ms.us\ncc.mt.us\ncc.nc.us\ncc.nd.us\ncc.ne.us\ncc.nh.us\ncc.nj.us\ncc.nm.us\ncc.nv.us\ncc.ny.us\ncc.oh.us\ncc.ok.us\ncc.or.us\ncc.pa.us\ncc.pr.us\ncc.ri.us\ncc.sc.us\ncc.sd.us\ncc.tn.us\ncc.tx.us\ncc.ut.us\ncc.vi.us\ncc.vt.us\ncc.va.us\ncc.wa.us\ncc.wi.us\ncc.wv.us\ncc.wy.us\nlib.ak.us\nlib.al.us\nlib.ar.us\nlib.as.us\nlib.az.us\nlib.ca.us\nlib.co.us\nlib.ct.us\nlib.dc.us\nlib.fl.us\nlib.ga.us\nlib.gu.us\nlib.hi.us\nlib.ia.us\nlib.id.us\nlib.il.us\nlib.in.us\nlib.ks.us\nlib.ky.us\nlib.la.us\nlib.ma.us\nlib.md.us\nlib.me.us\nlib.mi.us\nlib.mn.us\nlib.mo.us\nlib.ms.us\nlib.mt.us\nlib.nc.us\nlib.nd.us\nlib.ne.us\nlib.nh.us\nlib.nj.us\nlib.nm.us\nlib.nv.us\nlib.ny.us\nlib.oh.us\nlib.ok.us\nlib.or.us\nlib.pa.us\nlib.pr.us\nlib.ri.us\nlib.sc.us\nlib.sd.us\nlib.tn.us\nlib.tx.us\nlib.ut.us\nlib.vi.us\nlib.vt.us\nlib.va.us\nlib.wa.us\nlib.wi.us\nlib.wy.us\npvt.k12.ma.us\nchtr.k12.ma.us\nparoch.k12.ma.us\nann-arbor.mi.us\ncog.mi.us\ndst.mi.us\neaton.mi.us\ngen.mi.us\nmus.mi.us\ntec.mi.us\nwashtenaw.mi.us\nuy\ncom.uy\nedu.uy\ngub.uy\nmil.uy\nnet.uy\norg.uy\nuz\nco.uz\ncom.uz\nnet.uz\norg.uz\nva\nvc\ncom.vc\nnet.vc\norg.vc\ngov.vc\nmil.vc\nedu.vc\nve\narts.ve\nbib.ve\nco.ve\ncom.ve\ne12.ve\nedu.ve\nfirm.ve\ngob.ve\ngov.ve\ninfo.ve\nint.ve\nmil.ve\nnet.ve\nnom.ve\norg.ve\nrar.ve\nrec.ve\nstore.ve\ntec.ve\nweb.ve\nvg\nvi\nco.vi\ncom.vi\nk12.vi\nnet.vi\norg.vi\nvn\nac.vn\nai.vn\nbiz.vn\ncom.vn\nedu.vn\ngov.vn\nhealth.vn\nid.vn\ninfo.vn\nint.vn\nio.vn\nname.vn\nnet.vn\norg.vn\npro.vn\nangiang.vn\nbacgiang.vn\nbackan.vn\nbaclieu.vn\nbacninh.vn\nbaria-vungtau.vn\nbentre.vn\nbinhdinh.vn\nbinhduong.vn\nbinhphuoc.vn\nbinhthuan.vn\ncamau.vn\ncantho.vn\ncaobang.vn\ndaklak.vn\ndaknong.vn\ndanang.vn\ndienbien.vn\ndongnai.vn\ndongthap.vn\ngialai.vn\nhagiang.vn\nhaiduong.vn\nhaiphong.vn\nhanam.vn\nhanoi.vn\nhatinh.vn\nhaugiang.vn\nhoabinh.vn\nhungyen.vn\nkhanhhoa.vn\nkiengiang.vn\nkontum.vn\nlaichau.vn\nlamdong.vn\nlangson.vn\nlaocai.vn\nlongan.vn\nnamdinh.vn\nnghean.vn\nninhbinh.vn\nninhthuan.vn\nphutho.vn\nphuyen.vn\nquangbinh.vn\nquangnam.vn\nquangngai.vn\nquangninh.vn\nquangtri.vn\nsoctrang.vn\nsonla.vn\ntayninh.vn\nthaibinh.vn\nthainguyen.vn\nthanhhoa.vn\nthanhphohochiminh.vn\nthuathienhue.vn\ntiengiang.vn\ntravinh.vn\ntuyenquang.vn\nvinhlong.vn\nvinhphuc.vn\nyenbai.vn\nvu\ncom.vu\nedu.vu\nnet.vu\norg.vu\nwf\nws\ncom.ws\nnet.ws\norg.ws\ngov.ws\nedu.ws\nyt\nxn--mgbaam7a8h\nxn--y9a3aq\nxn--54b7fta0cc\nxn--90ae\nxn--mgbcpq6gpa1a\nxn--90ais\nxn--fiqs8s\nxn--fiqz9s\nxn--lgbbat1ad8j\nxn--wgbh1c\nxn--e1a4c\nxn--qxa6a\nxn--mgbah1a3hjkrd\nxn--node\nxn--qxam\nxn--j6w193g\nxn--55qx5d.xn--j6w193g\nxn--wcvs22d.xn--j6w193g\nxn--mxtq1m.xn--j6w193g\nxn--gmqw5a.xn--j6w193g\nxn--od0alg.xn--j6w193g\nxn--uc0atv.xn--j6w193g\nxn--2scrj9c\nxn--3hcrj9c\nxn--45br5cyl\nxn--h2breg3eve\nxn--h2brj9c8c\nxn--mgbgu82a\nxn--rvc1e0am3e\nxn--h2brj9c\nxn--mgbbh1a\nxn--mgbbh1a71e\nxn--fpcrj9c3d\nxn--gecrj9c\nxn--s9brj9c\nxn--45brj9c\nxn--xkc2dl3a5ee0h\nxn--mgba3a4f16a\nxn--mgba3a4fra\nxn--mgbtx2b\nxn--mgbayh7gpa\nxn--3e0b707e\nxn--80ao21a\nxn--q7ce6a\nxn--fzc2c9e2c\nxn--xkc2al3hye2a\nxn--mgbc0a9azcg\nxn--d1alf\nxn--l1acc\nxn--mix891f\nxn--mix082f\nxn--mgbx4cd0ab\nxn--mgb9awbf\nxn--mgbai9azgqp6j\nxn--mgbai9a5eva00b\nxn--ygbi2ammx\nxn--90a3ac\nxn--o1ac.xn--90a3ac\nxn--c1avg.xn--90a3ac\nxn--90azh.xn--90a3ac\nxn--d1at.xn--90a3ac\nxn--o1ach.xn--90a3ac\nxn--80au.xn--90a3ac\nxn--p1ai\nxn--wgbl6a\nxn--mgberp4a5d4ar\nxn--mgberp4a5d4a87g\nxn--mgbqly7c0a67fbc\nxn--mgbqly7cvafr\nxn--mgbpl2fh\nxn--yfro4i67o\nxn--clchc0ea0b2g2a9gcd\nxn--ogbpf8fl\nxn--mgbtf8fl\nxn--o3cw4h\nxn--12c1fe0br.xn--o3cw4h\nxn--12co0c3b4eva.xn--o3cw4h\nxn--h3cuzk1di.xn--o3cw4h\nxn--o3cyx2a.xn--o3cw4h\nxn--m3ch0j3a.xn--o3cw4h\nxn--12cfi8ixb8l.xn--o3cw4h\nxn--pgbs0dh\nxn--kpry57d\nxn--kprw13d\nxn--nnx388a\nxn--j1amh\nxn--mgb2ddes\nxxx\nye\ncom.ye\nedu.ye\ngov.ye\nnet.ye\nmil.ye\norg.ye\nac.za\nagric.za\nalt.za\nco.za\nedu.za\ngov.za\ngrondar.za\nlaw.za\nmil.za\nnet.za\nngo.za\nnic.za\nnis.za\nnom.za\norg.za\nschool.za\ntm.za\nweb.za\nzm\nac.zm\nbiz.zm\nco.zm\ncom.zm\nedu.zm\ngov.zm\ninfo.zm\nmil.zm\nnet.zm\norg.zm\nsch.zm\nzw\nac.zw\nco.zw\ngov.zw\nmil.zw\norg.zw\naaa\naarp\nabb\nabbott\nabbvie\nabc\nable\nabogado\nabudhabi\nacademy\naccenture\naccountant\naccountants\naco\nactor\nads\nadult\naeg\naetna\nafl\nafrica\nagakhan\nagency\naig\nairbus\nairforce\nairtel\nakdn\nalibaba\nalipay\nallfinanz\nallstate\nally\nalsace\nalstom\namazon\namericanexpress\namericanfamily\namex\namfam\namica\namsterdam\nanalytics\nandroid\nanquan\nanz\naol\napartments\napp\napple\naquarelle\narab\naramco\narchi\narmy\nart\narte\nasda\nassociates\nathleta\nattorney\nauction\naudi\naudible\naudio\nauspost\nauthor\nauto\nautos\navianca\naws\naxa\nazure\nbaby\nbaidu\nbanamex\nbananarepublic\nband\nbank\nbar\nbarcelona\nbarclaycard\nbarclays\nbarefoot\nbargains\nbaseball\nbasketball\nbauhaus\nbayern\nbbc\nbbt\nbbva\nbcg\nbcn\nbeats\nbeauty\nbeer\nbentley\nberlin\nbest\nbestbuy\nbet\nbharti\nbible\nbid\nbike\nbing\nbingo\nbio\nblack\nblackfriday\nblockbuster\nblog\nbloomberg\nblue\nbms\nbmw\nbnpparibas\nboats\nboehringer\nbofa\nbom\nbond\nboo\nbook\nbooking\nbosch\nbostik\nboston\nbot\nboutique\nbox\nbradesco\nbridgestone\nbroadway\nbroker\nbrother\nbrussels\nbuild\nbuilders\nbusiness\nbuy\nbuzz\nbzh\ncab\ncafe\ncal\ncall\ncalvinklein\ncam\ncamera\ncamp\ncanon\ncapetown\ncapital\ncapitalone\ncar\ncaravan\ncards\ncare\ncareer\ncareers\ncars\ncasa\ncase\ncash\ncasino\ncatering\ncatholic\ncba\ncbn\ncbre\ncenter\nceo\ncern\ncfa\ncfd\nchanel\nchannel\ncharity\nchase\nchat\ncheap\nchintai\nchristmas\nchrome\nchurch\ncipriani\ncircle\ncisco\ncitadel\nciti\ncitic\ncity\nclaims\ncleaning\nclick\nclinic\nclinique\nclothing\ncloud\nclub\nclubmed\ncoach\ncodes\ncoffee\ncollege\ncologne\ncomcast\ncommbank\ncommunity\ncompany\ncompare\ncomputer\ncomsec\ncondos\nconstruction\nconsulting\ncontact\ncontractors\ncooking\ncool\ncorsica\ncountry\ncoupon\ncoupons\ncourses\ncpa\ncredit\ncreditcard\ncreditunion\ncricket\ncrown\ncrs\ncruise\ncruises\ncuisinella\ncymru\ncyou\ndabur\ndad\ndance\ndata\ndate\ndating\ndatsun\nday\ndclk\ndds\ndeal\ndealer\ndeals\ndegree\ndelivery\ndell\ndeloitte\ndelta\ndemocrat\ndental\ndentist\ndesi\ndesign\ndev\ndhl\ndiamonds\ndiet\ndigital\ndirect\ndirectory\ndiscount\ndiscover\ndish\ndiy\ndnp\ndocs\ndoctor\ndog\ndomains\ndot\ndownload\ndrive\ndtv\ndubai\ndunlop\ndupont\ndurban\ndvag\ndvr\nearth\neat\neco\nedeka\neducation\nemail\nemerck\nenergy\nengineer\nengineering\nenterprises\nepson\nequipment\nericsson\nerni\nesq\nestate\neurovision\neus\nevents\nexchange\nexpert\nexposed\nexpress\nextraspace\nfage\nfail\nfairwinds\nfaith\nfamily\nfan\nfans\nfarm\nfarmers\nfashion\nfast\nfedex\nfeedback\nferrari\nferrero\nfidelity\nfido\nfilm\nfinal\nfinance\nfinancial\nfire\nfirestone\nfirmdale\nfish\nfishing\nfit\nfitness\nflickr\nflights\nflir\nflorist\nflowers\nfly\nfoo\nfood\nfootball\nford\nforex\nforsale\nforum\nfoundation\nfox\nfree\nfresenius\nfrl\nfrogans\nfrontier\nftr\nfujitsu\nfun\nfund\nfurniture\nfutbol\nfyi\ngal\ngallery\ngallo\ngallup\ngame\ngames\ngap\ngarden\ngay\ngbiz\ngdn\ngea\ngent\ngenting\ngeorge\nggee\ngift\ngifts\ngives\ngiving\nglass\ngle\nglobal\nglobo\ngmail\ngmbh\ngmo\ngmx\ngodaddy\ngold\ngoldpoint\ngolf\ngoo\ngoodyear\ngoog\ngoogle\ngop\ngot\ngrainger\ngraphics\ngratis\ngreen\ngripe\ngrocery\ngroup\nguardian\ngucci\nguge\nguide\nguitars\nguru\nhair\nhamburg\nhangout\nhaus\nhbo\nhdfc\nhdfcbank\nhealth\nhealthcare\nhelp\nhelsinki\nhere\nhermes\nhiphop\nhisamitsu\nhitachi\nhiv\nhkt\nhockey\nholdings\nholiday\nhomedepot\nhomegoods\nhomes\nhomesense\nhonda\nhorse\nhospital\nhost\nhosting\nhot\nhotels\nhotmail\nhouse\nhow\nhsbc\nhughes\nhyatt\nhyundai\nibm\nicbc\nice\nicu\nieee\nifm\nikano\nimamat\nimdb\nimmo\nimmobilien\ninc\nindustries\ninfiniti\ning\nink\ninstitute\ninsurance\ninsure\ninternational\nintuit\ninvestments\nipiranga\nirish\nismaili\nist\nistanbul\nitau\nitv\njaguar\njava\njcb\njeep\njetzt\njewelry\njio\njll\njmp\njnj\njoburg\njot\njoy\njpmorgan\njprs\njuegos\njuniper\nkaufen\nkddi\nkerryhotels\nkerrylogistics\nkerryproperties\nkfh\nkia\nkids\nkim\nkindle\nkitchen\nkiwi\nkoeln\nkomatsu\nkosher\nkpmg\nkpn\nkrd\nkred\nkuokgroup\nkyoto\nlacaixa\nlamborghini\nlamer\nlancaster\nland\nlandrover\nlanxess\nlasalle\nlat\nlatino\nlatrobe\nlaw\nlawyer\nlds\nlease\nleclerc\nlefrak\nlegal\nlego\nlexus\nlgbt\nlidl\nlife\nlifeinsurance\nlifestyle\nlighting\nlike\nlilly\nlimited\nlimo\nlincoln\nlink\nlipsy\nlive\nliving\nllc\nllp\nloan\nloans\nlocker\nlocus\nlol\nlondon\nlotte\nlotto\nlove\nlpl\nlplfinancial\nltd\nltda\nlundbeck\nluxe\nluxury\nmadrid\nmaif\nmaison\nmakeup\nman\nmanagement\nmango\nmap\nmarket\nmarketing\nmarkets\nmarriott\nmarshalls\nmattel\nmba\nmckinsey\nmed\nmedia\nmeet\nmelbourne\nmeme\nmemorial\nmen\nmenu\nmerckmsd\nmiami\nmicrosoft\nmini\nmint\nmit\nmitsubishi\nmlb\nmls\nmma\nmobile\nmoda\nmoe\nmoi\nmom\nmonash\nmoney\nmonster\nmormon\nmortgage\nmoscow\nmoto\nmotorcycles\nmov\nmovie\nmsd\nmtn\nmtr\nmusic\nnab\nnagoya\nnatura\nnavy\nnba\nnec\nnetbank\nnetflix\nnetwork\nneustar\nnew\nnews\nnext\nnextdirect\nnexus\nnfl\nngo\nnhk\nnico\nnike\nnikon\nninja\nnissan\nnissay\nnokia\nnorton\nnow\nnowruz\nnowtv\nnra\nnrw\nntt\nnyc\nobi\nobserver\noffice\nokinawa\nolayan\nolayangroup\noldnavy\nollo\nomega\none\nong\nonl\nonline\nooo\nopen\noracle\norange\norganic\norigins\nosaka\notsuka\nott\novh\npage\npanasonic\nparis\npars\npartners\nparts\nparty\npay\npccw\npet\npfizer\npharmacy\nphd\nphilips\nphone\nphoto\nphotography\nphotos\nphysio\npics\npictet\npictures\npid\npin\nping\npink\npioneer\npizza\nplace\nplay\nplaystation\nplumbing\nplus\npnc\npohl\npoker\npolitie\nporn\npramerica\npraxi\npress\nprime\nprod\nproductions\nprof\nprogressive\npromo\nproperties\nproperty\nprotection\npru\nprudential\npub\npwc\nqpon\nquebec\nquest\nracing\nradio\nread\nrealestate\nrealtor\nrealty\nrecipes\nred\nredstone\nredumbrella\nrehab\nreise\nreisen\nreit\nreliance\nren\nrent\nrentals\nrepair\nreport\nrepublican\nrest\nrestaurant\nreview\nreviews\nrexroth\nrich\nrichardli\nricoh\nril\nrio\nrip\nrocks\nrodeo\nrogers\nroom\nrsvp\nrugby\nruhr\nrun\nrwe\nryukyu\nsaarland\nsafe\nsafety\nsakura\nsale\nsalon\nsamsclub\nsamsung\nsandvik\nsandvikcoromant\nsanofi\nsap\nsarl\nsas\nsave\nsaxo\nsbi\nsbs\nscb\nschaeffler\nschmidt\nscholarships\nschool\nschule\nschwarz\nscience\nscot\nsearch\nseat\nsecure\nsecurity\nseek\nselect\nsener\nservices\nseven\nsew\nsex\nsexy\nsfr\nshangrila\nsharp\nshaw\nshell\nshia\nshiksha\nshoes\nshop\nshopping\nshouji\nshow\nsilk\nsina\nsingles\nsite\nski\nskin\nsky\nskype\nsling\nsmart\nsmile\nsncf\nsoccer\nsocial\nsoftbank\nsoftware\nsohu\nsolar\nsolutions\nsong\nsony\nsoy\nspa\nspace\nsport\nspot\nsrl\nstada\nstaples\nstar\nstatebank\nstatefarm\nstc\nstcgroup\nstockholm\nstorage\nstore\nstream\nstudio\nstudy\nstyle\nsucks\nsupplies\nsupply\nsupport\nsurf\nsurgery\nsuzuki\nswatch\nswiss\nsydney\nsystems\ntab\ntaipei\ntalk\ntaobao\ntarget\ntatamotors\ntatar\ntattoo\ntax\ntaxi\ntci\ntdk\nteam\ntech\ntechnology\ntemasek\ntennis\nteva\nthd\ntheater\ntheatre\ntiaa\ntickets\ntienda\ntips\ntires\ntirol\ntjmaxx\ntjx\ntkmaxx\ntmall\ntoday\ntokyo\ntools\ntop\ntoray\ntoshiba\ntotal\ntours\ntown\ntoyota\ntoys\ntrade\ntrading\ntraining\ntravel\ntravelers\ntravelersinsurance\ntrust\ntrv\ntube\ntui\ntunes\ntushu\ntvs\nubank\nubs\nunicom\nuniversity\nuno\nuol\nups\nvacations\nvana\nvanguard\nvegas\nventures\nverisign\nversicherung\nvet\nviajes\nvideo\nvig\nviking\nvillas\nvin\nvip\nvirgin\nvisa\nvision\nviva\nvivo\nvlaanderen\nvodka\nvolvo\nvote\nvoting\nvoto\nvoyage\nwales\nwalmart\nwalter\nwang\nwanggou\nwatch\nwatches\nweather\nweatherchannel\nwebcam\nweber\nwebsite\nwed\nwedding\nweibo\nweir\nwhoswho\nwien\nwiki\nwilliamhill\nwin\nwindows\nwine\nwinners\nwme\nwolterskluwer\nwoodside\nwork\nworks\nworld\nwow\nwtc\nwtf\nxbox\nxerox\nxfinity\nxihuan\nxin\nxn--11b4c3d\nxn--1ck2e1b\nxn--1qqw23a\nxn--30rr7y\nxn--3bst00m\nxn--3ds443g\nxn--3pxu8k\nxn--42c2d9a\nxn--45q11c\nxn--4gbrim\nxn--55qw42g\nxn--55qx5d\nxn--5su34j936bgsg\nxn--5tzm5g\nxn--6frz82g\nxn--6qq986b3xl\nxn--80adxhks\nxn--80aqecdr1a\nxn--80asehdb\nxn--80aswg\nxn--8y0a063a\nxn--9dbq2a\nxn--9et52u\nxn--9krt00a\nxn--b4w605ferd\nxn--bck1b9a5dre4c\nxn--c1avg\nxn--c2br7g\nxn--cck2b3b\nxn--cckwcxetd\nxn--cg4bki\nxn--czr694b\nxn--czrs0t\nxn--czru2d\nxn--d1acj3b\nxn--eckvdtc9d\nxn--efvy88h\nxn--fct429k\nxn--fhbei\nxn--fiq228c5hs\nxn--fiq64b\nxn--fjq720a\nxn--flw351e\nxn--fzys8d69uvgm\nxn--g2xx48c\nxn--gckr3f0f\nxn--gk3at1e\nxn--hxt814e\nxn--i1b6b1a6a2e\nxn--imr513n\nxn--io0a7i\nxn--j1aef\nxn--jlq480n2rg\nxn--jvr189m\nxn--kcrx77d1x4a\nxn--kput3i\nxn--mgba3a3ejt\nxn--mgba7c0bbn0a\nxn--mgbab2bd\nxn--mgbca7dzdo\nxn--mgbi4ecexp\nxn--mgbt3dhd\nxn--mk1bu44c\nxn--mxtq1m\nxn--ngbc5azd\nxn--ngbe9e0a\nxn--ngbrx\nxn--nqv7f\nxn--nqv7fs00ema\nxn--nyqy26a\nxn--otu796d\nxn--p1acf\nxn--pssy2u\nxn--q9jyb4c\nxn--qcka1pmc\nxn--rhqv96g\nxn--rovu88b\nxn--ses554g\nxn--t60b56a\nxn--tckwe\nxn--tiq49xqyj\nxn--unup4y\nxn--vermgensberater-ctb\nxn--vermgensberatung-pwb\nxn--vhquv\nxn--vuq861b\nxn--w4r85el8fhu5dnra\nxn--w4rs40l\nxn--xhq521b\nxn--zfr164b\nxyz\nyachts\nyahoo\nyamaxun\nyandex\nyodobashi\nyoga\nyokohama\nyou\nyoutube\nyun\nzappos\nzara\nzero\nzip\nzone\nzuerich\ncc.ua\ninf.ua\nltd.ua\n611.to\ngraphox.us\n*.devcdnaccesso.com\n*.on-acorn.io\nactivetrail.biz\nadobeaemcloud.com\n*.dev.adobeaemcloud.com\nhlx.live\nadobeaemcloud.net\nhlx.page\nhlx3.page\nadobeio-static.net\nadobeioruntime.net\nbeep.pl\nairkitapps.com\nairkitapps-au.com\nairkitapps.eu\naivencloud.com\nakadns.net\nakamai.net\nakamai-staging.net\nakamaiedge.net\nakamaiedge-staging.net\nakamaihd.net\nakamaihd-staging.net\nakamaiorigin.net\nakamaiorigin-staging.net\nakamaized.net\nakamaized-staging.net\nedgekey.net\nedgekey-staging.net\nedgesuite.net\nedgesuite-staging.net\nbarsy.ca\n*.compute.estate\n*.alces.network\nkasserver.com\naltervista.org\nalwaysdata.net\nmyamaze.net\nexecute-api.cn-north-1.amazonaws.com.cn\nexecute-api.cn-northwest-1.amazonaws.com.cn\nexecute-api.af-south-1.amazonaws.com\nexecute-api.ap-east-1.amazonaws.com\nexecute-api.ap-northeast-1.amazonaws.com\nexecute-api.ap-northeast-2.amazonaws.com\nexecute-api.ap-northeast-3.amazonaws.com\nexecute-api.ap-south-1.amazonaws.com\nexecute-api.ap-south-2.amazonaws.com\nexecute-api.ap-southeast-1.amazonaws.com\nexecute-api.ap-southeast-2.amazonaws.com\nexecute-api.ap-southeast-3.amazonaws.com\nexecute-api.ap-southeast-4.amazonaws.com\nexecute-api.ca-central-1.amazonaws.com\nexecute-api.eu-central-1.amazonaws.com\nexecute-api.eu-central-2.amazonaws.com\nexecute-api.eu-north-1.amazonaws.com\nexecute-api.eu-south-1.amazonaws.com\nexecute-api.eu-south-2.amazonaws.com\nexecute-api.eu-west-1.amazonaws.com\nexecute-api.eu-west-2.amazonaws.com\nexecute-api.eu-west-3.amazonaws.com\nexecute-api.il-central-1.amazonaws.com\nexecute-api.me-central-1.amazonaws.com\nexecute-api.me-south-1.amazonaws.com\nexecute-api.sa-east-1.amazonaws.com\nexecute-api.us-east-1.amazonaws.com\nexecute-api.us-east-2.amazonaws.com\nexecute-api.us-gov-east-1.amazonaws.com\nexecute-api.us-gov-west-1.amazonaws.com\nexecute-api.us-west-1.amazonaws.com\nexecute-api.us-west-2.amazonaws.com\ncloudfront.net\nauth.af-south-1.amazoncognito.com\nauth.ap-northeast-1.amazoncognito.com\nauth.ap-northeast-2.amazoncognito.com\nauth.ap-northeast-3.amazoncognito.com\nauth.ap-south-1.amazoncognito.com\nauth.ap-southeast-1.amazoncognito.com\nauth.ap-southeast-2.amazoncognito.com\nauth.ap-southeast-3.amazoncognito.com\nauth.ca-central-1.amazoncognito.com\nauth.eu-central-1.amazoncognito.com\nauth.eu-north-1.amazoncognito.com\nauth.eu-south-1.amazoncognito.com\nauth.eu-west-1.amazoncognito.com\nauth.eu-west-2.amazoncognito.com\nauth.eu-west-3.amazoncognito.com\nauth.il-central-1.amazoncognito.com\nauth.me-south-1.amazoncognito.com\nauth.sa-east-1.amazoncognito.com\nauth.us-east-1.amazoncognito.com\nauth-fips.us-east-1.amazoncognito.com\nauth.us-east-2.amazoncognito.com\nauth-fips.us-east-2.amazoncognito.com\nauth-fips.us-gov-west-1.amazoncognito.com\nauth.us-west-1.amazoncognito.com\nauth-fips.us-west-1.amazoncognito.com\nauth.us-west-2.amazoncognito.com\nauth-fips.us-west-2.amazoncognito.com\n*.compute.amazonaws.com\n*.compute-1.amazonaws.com\n*.compute.amazonaws.com.cn\nus-east-1.amazonaws.com\nemrappui-prod.cn-north-1.amazonaws.com.cn\nemrnotebooks-prod.cn-north-1.amazonaws.com.cn\nemrstudio-prod.cn-north-1.amazonaws.com.cn\nemrappui-prod.cn-northwest-1.amazonaws.com.cn\nemrnotebooks-prod.cn-northwest-1.amazonaws.com.cn\nemrstudio-prod.cn-northwest-1.amazonaws.com.cn\nemrappui-prod.af-south-1.amazonaws.com\nemrnotebooks-prod.af-south-1.amazonaws.com\nemrstudio-prod.af-south-1.amazonaws.com\nemrappui-prod.ap-east-1.amazonaws.com\nemrnotebooks-prod.ap-east-1.amazonaws.com\nemrstudio-prod.ap-east-1.amazonaws.com\nemrappui-prod.ap-northeast-1.amazonaws.com\nemrnotebooks-prod.ap-northeast-1.amazonaws.com\nemrstudio-prod.ap-northeast-1.amazonaws.com\nemrappui-prod.ap-northeast-2.amazonaws.com\nemrnotebooks-prod.ap-northeast-2.amazonaws.com\nemrstudio-prod.ap-northeast-2.amazonaws.com\nemrappui-prod.ap-northeast-3.amazonaws.com\nemrnotebooks-prod.ap-northeast-3.amazonaws.com\nemrstudio-prod.ap-northeast-3.amazonaws.com\nemrappui-prod.ap-south-1.amazonaws.com\nemrnotebooks-prod.ap-south-1.amazonaws.com\nemrstudio-prod.ap-south-1.amazonaws.com\nemrappui-prod.ap-southeast-1.amazonaws.com\nemrnotebooks-prod.ap-southeast-1.amazonaws.com\nemrstudio-prod.ap-southeast-1.amazonaws.com\nemrappui-prod.ap-southeast-2.amazonaws.com\nemrnotebooks-prod.ap-southeast-2.amazonaws.com\nemrstudio-prod.ap-southeast-2.amazonaws.com\nemrappui-prod.ap-southeast-3.amazonaws.com\nemrnotebooks-prod.ap-southeast-3.amazonaws.com\nemrstudio-prod.ap-southeast-3.amazonaws.com\nemrappui-prod.ca-central-1.amazonaws.com\nemrnotebooks-prod.ca-central-1.amazonaws.com\nemrstudio-prod.ca-central-1.amazonaws.com\nemrappui-prod.eu-central-1.amazonaws.com\nemrnotebooks-prod.eu-central-1.amazonaws.com\nemrstudio-prod.eu-central-1.amazonaws.com\nemrappui-prod.eu-north-1.amazonaws.com\nemrnotebooks-prod.eu-north-1.amazonaws.com\nemrstudio-prod.eu-north-1.amazonaws.com\nemrappui-prod.eu-south-1.amazonaws.com\nemrnotebooks-prod.eu-south-1.amazonaws.com\nemrstudio-prod.eu-south-1.amazonaws.com\nemrappui-prod.eu-west-1.amazonaws.com\nemrnotebooks-prod.eu-west-1.amazonaws.com\nemrstudio-prod.eu-west-1.amazonaws.com\nemrappui-prod.eu-west-2.amazonaws.com\nemrnotebooks-prod.eu-west-2.amazonaws.com\nemrstudio-prod.eu-west-2.amazonaws.com\nemrappui-prod.eu-west-3.amazonaws.com\nemrnotebooks-prod.eu-west-3.amazonaws.com\nemrstudio-prod.eu-west-3.amazonaws.com\nemrappui-prod.me-central-1.amazonaws.com\nemrnotebooks-prod.me-central-1.amazonaws.com\nemrstudio-prod.me-central-1.amazonaws.com\nemrappui-prod.me-south-1.amazonaws.com\nemrnotebooks-prod.me-south-1.amazonaws.com\nemrstudio-prod.me-south-1.amazonaws.com\nemrappui-prod.sa-east-1.amazonaws.com\nemrnotebooks-prod.sa-east-1.amazonaws.com\nemrstudio-prod.sa-east-1.amazonaws.com\nemrappui-prod.us-east-1.amazonaws.com\nemrnotebooks-prod.us-east-1.amazonaws.com\nemrstudio-prod.us-east-1.amazonaws.com\nemrappui-prod.us-east-2.amazonaws.com\nemrnotebooks-prod.us-east-2.amazonaws.com\nemrstudio-prod.us-east-2.amazonaws.com\nemrappui-prod.us-gov-east-1.amazonaws.com\nemrnotebooks-prod.us-gov-east-1.amazonaws.com\nemrstudio-prod.us-gov-east-1.amazonaws.com\nemrappui-prod.us-gov-west-1.amazonaws.com\nemrnotebooks-prod.us-gov-west-1.amazonaws.com\nemrstudio-prod.us-gov-west-1.amazonaws.com\nemrappui-prod.us-west-1.amazonaws.com\nemrnotebooks-prod.us-west-1.amazonaws.com\nemrstudio-prod.us-west-1.amazonaws.com\nemrappui-prod.us-west-2.amazonaws.com\nemrnotebooks-prod.us-west-2.amazonaws.com\nemrstudio-prod.us-west-2.amazonaws.com\n*.cn-north-1.airflow.amazonaws.com.cn\n*.cn-northwest-1.airflow.amazonaws.com.cn\n*.ap-northeast-1.airflow.amazonaws.com\n*.ap-northeast-2.airflow.amazonaws.com\n*.ap-south-1.airflow.amazonaws.com\n*.ap-southeast-1.airflow.amazonaws.com\n*.ap-southeast-2.airflow.amazonaws.com\n*.ca-central-1.airflow.amazonaws.com\n*.eu-central-1.airflow.amazonaws.com\n*.eu-north-1.airflow.amazonaws.com\n*.eu-west-1.airflow.amazonaws.com\n*.eu-west-2.airflow.amazonaws.com\n*.eu-west-3.airflow.amazonaws.com\n*.sa-east-1.airflow.amazonaws.com\n*.us-east-1.airflow.amazonaws.com\n*.us-east-2.airflow.amazonaws.com\n*.us-west-2.airflow.amazonaws.com\ns3.dualstack.cn-north-1.amazonaws.com.cn\ns3-accesspoint.dualstack.cn-north-1.amazonaws.com.cn\ns3-website.dualstack.cn-north-1.amazonaws.com.cn\ns3.cn-north-1.amazonaws.com.cn\ns3-accesspoint.cn-north-1.amazonaws.com.cn\ns3-deprecated.cn-north-1.amazonaws.com.cn\ns3-object-lambda.cn-north-1.amazonaws.com.cn\ns3-website.cn-north-1.amazonaws.com.cn\ns3.dualstack.cn-northwest-1.amazonaws.com.cn\ns3-accesspoint.dualstack.cn-northwest-1.amazonaws.com.cn\ns3.cn-northwest-1.amazonaws.com.cn\ns3-accesspoint.cn-northwest-1.amazonaws.com.cn\ns3-object-lambda.cn-northwest-1.amazonaws.com.cn\ns3-website.cn-northwest-1.amazonaws.com.cn\ns3.dualstack.af-south-1.amazonaws.com\ns3-accesspoint.dualstack.af-south-1.amazonaws.com\ns3-website.dualstack.af-south-1.amazonaws.com\ns3.af-south-1.amazonaws.com\ns3-accesspoint.af-south-1.amazonaws.com\ns3-object-lambda.af-south-1.amazonaws.com\ns3-website.af-south-1.amazonaws.com\ns3.dualstack.ap-east-1.amazonaws.com\ns3-accesspoint.dualstack.ap-east-1.amazonaws.com\ns3.ap-east-1.amazonaws.com\ns3-accesspoint.ap-east-1.amazonaws.com\ns3-object-lambda.ap-east-1.amazonaws.com\ns3-website.ap-east-1.amazonaws.com\ns3.dualstack.ap-northeast-1.amazonaws.com\ns3-accesspoint.dualstack.ap-northeast-1.amazonaws.com\ns3-website.dualstack.ap-northeast-1.amazonaws.com\ns3.ap-northeast-1.amazonaws.com\ns3-accesspoint.ap-northeast-1.amazonaws.com\ns3-object-lambda.ap-northeast-1.amazonaws.com\ns3-website.ap-northeast-1.amazonaws.com\ns3.dualstack.ap-northeast-2.amazonaws.com\ns3-accesspoint.dualstack.ap-northeast-2.amazonaws.com\ns3-website.dualstack.ap-northeast-2.amazonaws.com\ns3.ap-northeast-2.amazonaws.com\ns3-accesspoint.ap-northeast-2.amazonaws.com\ns3-object-lambda.ap-northeast-2.amazonaws.com\ns3-website.ap-northeast-2.amazonaws.com\ns3.dualstack.ap-northeast-3.amazonaws.com\ns3-accesspoint.dualstack.ap-northeast-3.amazonaws.com\ns3-website.dualstack.ap-northeast-3.amazonaws.com\ns3.ap-northeast-3.amazonaws.com\ns3-accesspoint.ap-northeast-3.amazonaws.com\ns3-object-lambda.ap-northeast-3.amazonaws.com\ns3-website.ap-northeast-3.amazonaws.com\ns3.dualstack.ap-south-1.amazonaws.com\ns3-accesspoint.dualstack.ap-south-1.amazonaws.com\ns3-website.dualstack.ap-south-1.amazonaws.com\ns3.ap-south-1.amazonaws.com\ns3-accesspoint.ap-south-1.amazonaws.com\ns3-object-lambda.ap-south-1.amazonaws.com\ns3-website.ap-south-1.amazonaws.com\ns3.dualstack.ap-south-2.amazonaws.com\ns3-accesspoint.dualstack.ap-south-2.amazonaws.com\ns3.ap-south-2.amazonaws.com\ns3-accesspoint.ap-south-2.amazonaws.com\ns3-object-lambda.ap-south-2.amazonaws.com\ns3-website.ap-south-2.amazonaws.com\ns3.dualstack.ap-southeast-1.amazonaws.com\ns3-accesspoint.dualstack.ap-southeast-1.amazonaws.com\ns3-website.dualstack.ap-southeast-1.amazonaws.com\ns3.ap-southeast-1.amazonaws.com\ns3-accesspoint.ap-southeast-1.amazonaws.com\ns3-object-lambda.ap-southeast-1.amazonaws.com\ns3-website.ap-southeast-1.amazonaws.com\ns3.dualstack.ap-southeast-2.amazonaws.com\ns3-accesspoint.dualstack.ap-southeast-2.amazonaws.com\ns3-website.dualstack.ap-southeast-2.amazonaws.com\ns3.ap-southeast-2.amazonaws.com\ns3-accesspoint.ap-southeast-2.amazonaws.com\ns3-object-lambda.ap-southeast-2.amazonaws.com\ns3-website.ap-southeast-2.amazonaws.com\ns3.dualstack.ap-southeast-3.amazonaws.com\ns3-accesspoint.dualstack.ap-southeast-3.amazonaws.com\ns3.ap-southeast-3.amazonaws.com\ns3-accesspoint.ap-southeast-3.amazonaws.com\ns3-object-lambda.ap-southeast-3.amazonaws.com\ns3-website.ap-southeast-3.amazonaws.com\ns3.dualstack.ap-southeast-4.amazonaws.com\ns3-accesspoint.dualstack.ap-southeast-4.amazonaws.com\ns3.ap-southeast-4.amazonaws.com\ns3-accesspoint.ap-southeast-4.amazonaws.com\ns3-object-lambda.ap-southeast-4.amazonaws.com\ns3-website.ap-southeast-4.amazonaws.com\ns3.dualstack.ca-central-1.amazonaws.com\ns3-accesspoint.dualstack.ca-central-1.amazonaws.com\ns3-accesspoint-fips.dualstack.ca-central-1.amazonaws.com\ns3-fips.dualstack.ca-central-1.amazonaws.com\ns3-website.dualstack.ca-central-1.amazonaws.com\ns3.ca-central-1.amazonaws.com\ns3-accesspoint.ca-central-1.amazonaws.com\ns3-accesspoint-fips.ca-central-1.amazonaws.com\ns3-fips.ca-central-1.amazonaws.com\ns3-object-lambda.ca-central-1.amazonaws.com\ns3-website.ca-central-1.amazonaws.com\ns3.dualstack.eu-central-1.amazonaws.com\ns3-accesspoint.dualstack.eu-central-1.amazonaws.com\ns3-website.dualstack.eu-central-1.amazonaws.com\ns3.eu-central-1.amazonaws.com\ns3-accesspoint.eu-central-1.amazonaws.com\ns3-object-lambda.eu-central-1.amazonaws.com\ns3-website.eu-central-1.amazonaws.com\ns3.dualstack.eu-central-2.amazonaws.com\ns3-accesspoint.dualstack.eu-central-2.amazonaws.com\ns3.eu-central-2.amazonaws.com\ns3-accesspoint.eu-central-2.amazonaws.com\ns3-object-lambda.eu-central-2.amazonaws.com\ns3-website.eu-central-2.amazonaws.com\ns3.dualstack.eu-north-1.amazonaws.com\ns3-accesspoint.dualstack.eu-north-1.amazonaws.com\ns3.eu-north-1.amazonaws.com\ns3-accesspoint.eu-north-1.amazonaws.com\ns3-object-lambda.eu-north-1.amazonaws.com\ns3-website.eu-north-1.amazonaws.com\ns3.dualstack.eu-south-1.amazonaws.com\ns3-accesspoint.dualstack.eu-south-1.amazonaws.com\ns3-website.dualstack.eu-south-1.amazonaws.com\ns3.eu-south-1.amazonaws.com\ns3-accesspoint.eu-south-1.amazonaws.com\ns3-object-lambda.eu-south-1.amazonaws.com\ns3-website.eu-south-1.amazonaws.com\ns3.dualstack.eu-south-2.amazonaws.com\ns3-accesspoint.dualstack.eu-south-2.amazonaws.com\ns3.eu-south-2.amazonaws.com\ns3-accesspoint.eu-south-2.amazonaws.com\ns3-object-lambda.eu-south-2.amazonaws.com\ns3-website.eu-south-2.amazonaws.com\ns3.dualstack.eu-west-1.amazonaws.com\ns3-accesspoint.dualstack.eu-west-1.amazonaws.com\ns3-website.dualstack.eu-west-1.amazonaws.com\ns3.eu-west-1.amazonaws.com\ns3-accesspoint.eu-west-1.amazonaws.com\ns3-deprecated.eu-west-1.amazonaws.com\ns3-object-lambda.eu-west-1.amazonaws.com\ns3-website.eu-west-1.amazonaws.com\ns3.dualstack.eu-west-2.amazonaws.com\ns3-accesspoint.dualstack.eu-west-2.amazonaws.com\ns3.eu-west-2.amazonaws.com\ns3-accesspoint.eu-west-2.amazonaws.com\ns3-object-lambda.eu-west-2.amazonaws.com\ns3-website.eu-west-2.amazonaws.com\ns3.dualstack.eu-west-3.amazonaws.com\ns3-accesspoint.dualstack.eu-west-3.amazonaws.com\ns3-website.dualstack.eu-west-3.amazonaws.com\ns3.eu-west-3.amazonaws.com\ns3-accesspoint.eu-west-3.amazonaws.com\ns3-object-lambda.eu-west-3.amazonaws.com\ns3-website.eu-west-3.amazonaws.com\ns3.dualstack.il-central-1.amazonaws.com\ns3-accesspoint.dualstack.il-central-1.amazonaws.com\ns3.il-central-1.amazonaws.com\ns3-accesspoint.il-central-1.amazonaws.com\ns3-object-lambda.il-central-1.amazonaws.com\ns3-website.il-central-1.amazonaws.com\ns3.dualstack.me-central-1.amazonaws.com\ns3-accesspoint.dualstack.me-central-1.amazonaws.com\ns3.me-central-1.amazonaws.com\ns3-accesspoint.me-central-1.amazonaws.com\ns3-object-lambda.me-central-1.amazonaws.com\ns3-website.me-central-1.amazonaws.com\ns3.dualstack.me-south-1.amazonaws.com\ns3-accesspoint.dualstack.me-south-1.amazonaws.com\ns3.me-south-1.amazonaws.com\ns3-accesspoint.me-south-1.amazonaws.com\ns3-object-lambda.me-south-1.amazonaws.com\ns3-website.me-south-1.amazonaws.com\ns3.amazonaws.com\ns3-1.amazonaws.com\ns3-ap-east-1.amazonaws.com\ns3-ap-northeast-1.amazonaws.com\ns3-ap-northeast-2.amazonaws.com\ns3-ap-northeast-3.amazonaws.com\ns3-ap-south-1.amazonaws.com\ns3-ap-southeast-1.amazonaws.com\ns3-ap-southeast-2.amazonaws.com\ns3-ca-central-1.amazonaws.com\ns3-eu-central-1.amazonaws.com\ns3-eu-north-1.amazonaws.com\ns3-eu-west-1.amazonaws.com\ns3-eu-west-2.amazonaws.com\ns3-eu-west-3.amazonaws.com\ns3-external-1.amazonaws.com\ns3-fips-us-gov-east-1.amazonaws.com\ns3-fips-us-gov-west-1.amazonaws.com\nmrap.accesspoint.s3-global.amazonaws.com\ns3-me-south-1.amazonaws.com\ns3-sa-east-1.amazonaws.com\ns3-us-east-2.amazonaws.com\ns3-us-gov-east-1.amazonaws.com\ns3-us-gov-west-1.amazonaws.com\ns3-us-west-1.amazonaws.com\ns3-us-west-2.amazonaws.com\ns3-website-ap-northeast-1.amazonaws.com\ns3-website-ap-southeast-1.amazonaws.com\ns3-website-ap-southeast-2.amazonaws.com\ns3-website-eu-west-1.amazonaws.com\ns3-website-sa-east-1.amazonaws.com\ns3-website-us-east-1.amazonaws.com\ns3-website-us-gov-west-1.amazonaws.com\ns3-website-us-west-1.amazonaws.com\ns3-website-us-west-2.amazonaws.com\ns3.dualstack.sa-east-1.amazonaws.com\ns3-accesspoint.dualstack.sa-east-1.amazonaws.com\ns3-website.dualstack.sa-east-1.amazonaws.com\ns3.sa-east-1.amazonaws.com\ns3-accesspoint.sa-east-1.amazonaws.com\ns3-object-lambda.sa-east-1.amazonaws.com\ns3-website.sa-east-1.amazonaws.com\ns3.dualstack.us-east-1.amazonaws.com\ns3-accesspoint.dualstack.us-east-1.amazonaws.com\ns3-accesspoint-fips.dualstack.us-east-1.amazonaws.com\ns3-fips.dualstack.us-east-1.amazonaws.com\ns3-website.dualstack.us-east-1.amazonaws.com\ns3.us-east-1.amazonaws.com\ns3-accesspoint.us-east-1.amazonaws.com\ns3-accesspoint-fips.us-east-1.amazonaws.com\ns3-deprecated.us-east-1.amazonaws.com\ns3-fips.us-east-1.amazonaws.com\ns3-object-lambda.us-east-1.amazonaws.com\ns3-website.us-east-1.amazonaws.com\ns3.dualstack.us-east-2.amazonaws.com\ns3-accesspoint.dualstack.us-east-2.amazonaws.com\ns3-accesspoint-fips.dualstack.us-east-2.amazonaws.com\ns3-fips.dualstack.us-east-2.amazonaws.com\ns3.us-east-2.amazonaws.com\ns3-accesspoint.us-east-2.amazonaws.com\ns3-accesspoint-fips.us-east-2.amazonaws.com\ns3-deprecated.us-east-2.amazonaws.com\ns3-fips.us-east-2.amazonaws.com\ns3-object-lambda.us-east-2.amazonaws.com\ns3-website.us-east-2.amazonaws.com\ns3.dualstack.us-gov-east-1.amazonaws.com\ns3-accesspoint.dualstack.us-gov-east-1.amazonaws.com\ns3-accesspoint-fips.dualstack.us-gov-east-1.amazonaws.com\ns3-fips.dualstack.us-gov-east-1.amazonaws.com\ns3.us-gov-east-1.amazonaws.com\ns3-accesspoint.us-gov-east-1.amazonaws.com\ns3-accesspoint-fips.us-gov-east-1.amazonaws.com\ns3-fips.us-gov-east-1.amazonaws.com\ns3-object-lambda.us-gov-east-1.amazonaws.com\ns3-website.us-gov-east-1.amazonaws.com\ns3.dualstack.us-gov-west-1.amazonaws.com\ns3-accesspoint.dualstack.us-gov-west-1.amazonaws.com\ns3-accesspoint-fips.dualstack.us-gov-west-1.amazonaws.com\ns3-fips.dualstack.us-gov-west-1.amazonaws.com\ns3.us-gov-west-1.amazonaws.com\ns3-accesspoint.us-gov-west-1.amazonaws.com\ns3-accesspoint-fips.us-gov-west-1.amazonaws.com\ns3-fips.us-gov-west-1.amazonaws.com\ns3-object-lambda.us-gov-west-1.amazonaws.com\ns3-website.us-gov-west-1.amazonaws.com\ns3.dualstack.us-west-1.amazonaws.com\ns3-accesspoint.dualstack.us-west-1.amazonaws.com\ns3-accesspoint-fips.dualstack.us-west-1.amazonaws.com\ns3-fips.dualstack.us-west-1.amazonaws.com\ns3-website.dualstack.us-west-1.amazonaws.com\ns3.us-west-1.amazonaws.com\ns3-accesspoint.us-west-1.amazonaws.com\ns3-accesspoint-fips.us-west-1.amazonaws.com\ns3-fips.us-west-1.amazonaws.com\ns3-object-lambda.us-west-1.amazonaws.com\ns3-website.us-west-1.amazonaws.com\ns3.dualstack.us-west-2.amazonaws.com\ns3-accesspoint.dualstack.us-west-2.amazonaws.com\ns3-accesspoint-fips.dualstack.us-west-2.amazonaws.com\ns3-fips.dualstack.us-west-2.amazonaws.com\ns3-website.dualstack.us-west-2.amazonaws.com\ns3.us-west-2.amazonaws.com\ns3-accesspoint.us-west-2.amazonaws.com\ns3-accesspoint-fips.us-west-2.amazonaws.com\ns3-deprecated.us-west-2.amazonaws.com\ns3-fips.us-west-2.amazonaws.com\ns3-object-lambda.us-west-2.amazonaws.com\ns3-website.us-west-2.amazonaws.com\nnotebook.af-south-1.sagemaker.aws\nnotebook.ap-east-1.sagemaker.aws\nnotebook.ap-northeast-1.sagemaker.aws\nnotebook.ap-northeast-2.sagemaker.aws\nnotebook.ap-northeast-3.sagemaker.aws\nnotebook.ap-south-1.sagemaker.aws\nnotebook.ap-south-2.sagemaker.aws\nnotebook.ap-southeast-1.sagemaker.aws\nnotebook.ap-southeast-2.sagemaker.aws\nnotebook.ap-southeast-3.sagemaker.aws\nnotebook.ap-southeast-4.sagemaker.aws\nnotebook.ca-central-1.sagemaker.aws\nnotebook.eu-central-1.sagemaker.aws\nnotebook.eu-central-2.sagemaker.aws\nnotebook.eu-north-1.sagemaker.aws\nnotebook.eu-south-1.sagemaker.aws\nnotebook.eu-south-2.sagemaker.aws\nnotebook.eu-west-1.sagemaker.aws\nnotebook.eu-west-2.sagemaker.aws\nnotebook.eu-west-3.sagemaker.aws\nnotebook.il-central-1.sagemaker.aws\nnotebook.me-central-1.sagemaker.aws\nnotebook.me-south-1.sagemaker.aws\nnotebook.sa-east-1.sagemaker.aws\nnotebook.us-east-1.sagemaker.aws\nnotebook-fips.us-east-1.sagemaker.aws\nnotebook.us-east-2.sagemaker.aws\nnotebook-fips.us-east-2.sagemaker.aws\nnotebook.us-gov-east-1.sagemaker.aws\nnotebook-fips.us-gov-east-1.sagemaker.aws\nnotebook.us-gov-west-1.sagemaker.aws\nnotebook-fips.us-gov-west-1.sagemaker.aws\nnotebook.us-west-1.sagemaker.aws\nnotebook.us-west-2.sagemaker.aws\nnotebook-fips.us-west-2.sagemaker.aws\nnotebook.cn-north-1.sagemaker.com.cn\nnotebook.cn-northwest-1.sagemaker.com.cn\nstudio.af-south-1.sagemaker.aws\nstudio.ap-east-1.sagemaker.aws\nstudio.ap-northeast-1.sagemaker.aws\nstudio.ap-northeast-2.sagemaker.aws\nstudio.ap-northeast-3.sagemaker.aws\nstudio.ap-south-1.sagemaker.aws\nstudio.ap-southeast-1.sagemaker.aws\nstudio.ap-southeast-2.sagemaker.aws\nstudio.ap-southeast-3.sagemaker.aws\nstudio.ca-central-1.sagemaker.aws\nstudio.eu-central-1.sagemaker.aws\nstudio.eu-north-1.sagemaker.aws\nstudio.eu-south-1.sagemaker.aws\nstudio.eu-west-1.sagemaker.aws\nstudio.eu-west-2.sagemaker.aws\nstudio.eu-west-3.sagemaker.aws\nstudio.il-central-1.sagemaker.aws\nstudio.me-central-1.sagemaker.aws\nstudio.me-south-1.sagemaker.aws\nstudio.sa-east-1.sagemaker.aws\nstudio.us-east-1.sagemaker.aws\nstudio.us-east-2.sagemaker.aws\nstudio.us-gov-east-1.sagemaker.aws\nstudio-fips.us-gov-east-1.sagemaker.aws\nstudio.us-gov-west-1.sagemaker.aws\nstudio-fips.us-gov-west-1.sagemaker.aws\nstudio.us-west-1.sagemaker.aws\nstudio.us-west-2.sagemaker.aws\nstudio.cn-north-1.sagemaker.com.cn\nstudio.cn-northwest-1.sagemaker.com.cn\nanalytics-gateway.ap-northeast-1.amazonaws.com\nanalytics-gateway.ap-northeast-2.amazonaws.com\nanalytics-gateway.ap-south-1.amazonaws.com\nanalytics-gateway.ap-southeast-1.amazonaws.com\nanalytics-gateway.ap-southeast-2.amazonaws.com\nanalytics-gateway.eu-central-1.amazonaws.com\nanalytics-gateway.eu-west-1.amazonaws.com\nanalytics-gateway.us-east-1.amazonaws.com\nanalytics-gateway.us-east-2.amazonaws.com\nanalytics-gateway.us-west-2.amazonaws.com\n*.amplifyapp.com\n*.awsapprunner.com\nwebview-assets.aws-cloud9.af-south-1.amazonaws.com\nvfs.cloud9.af-south-1.amazonaws.com\nwebview-assets.cloud9.af-south-1.amazonaws.com\nwebview-assets.aws-cloud9.ap-east-1.amazonaws.com\nvfs.cloud9.ap-east-1.amazonaws.com\nwebview-assets.cloud9.ap-east-1.amazonaws.com\nwebview-assets.aws-cloud9.ap-northeast-1.amazonaws.com\nvfs.cloud9.ap-northeast-1.amazonaws.com\nwebview-assets.cloud9.ap-northeast-1.amazonaws.com\nwebview-assets.aws-cloud9.ap-northeast-2.amazonaws.com\nvfs.cloud9.ap-northeast-2.amazonaws.com\nwebview-assets.cloud9.ap-northeast-2.amazonaws.com\nwebview-assets.aws-cloud9.ap-northeast-3.amazonaws.com\nvfs.cloud9.ap-northeast-3.amazonaws.com\nwebview-assets.cloud9.ap-northeast-3.amazonaws.com\nwebview-assets.aws-cloud9.ap-south-1.amazonaws.com\nvfs.cloud9.ap-south-1.amazonaws.com\nwebview-assets.cloud9.ap-south-1.amazonaws.com\nwebview-assets.aws-cloud9.ap-southeast-1.amazonaws.com\nvfs.cloud9.ap-southeast-1.amazonaws.com\nwebview-assets.cloud9.ap-southeast-1.amazonaws.com\nwebview-assets.aws-cloud9.ap-southeast-2.amazonaws.com\nvfs.cloud9.ap-southeast-2.amazonaws.com\nwebview-assets.cloud9.ap-southeast-2.amazonaws.com\nwebview-assets.aws-cloud9.ca-central-1.amazonaws.com\nvfs.cloud9.ca-central-1.amazonaws.com\nwebview-assets.cloud9.ca-central-1.amazonaws.com\nwebview-assets.aws-cloud9.eu-central-1.amazonaws.com\nvfs.cloud9.eu-central-1.amazonaws.com\nwebview-assets.cloud9.eu-central-1.amazonaws.com\nwebview-assets.aws-cloud9.eu-north-1.amazonaws.com\nvfs.cloud9.eu-north-1.amazonaws.com\nwebview-assets.cloud9.eu-north-1.amazonaws.com\nwebview-assets.aws-cloud9.eu-south-1.amazonaws.com\nvfs.cloud9.eu-south-1.amazonaws.com\nwebview-assets.cloud9.eu-south-1.amazonaws.com\nwebview-assets.aws-cloud9.eu-west-1.amazonaws.com\nvfs.cloud9.eu-west-1.amazonaws.com\nwebview-assets.cloud9.eu-west-1.amazonaws.com\nwebview-assets.aws-cloud9.eu-west-2.amazonaws.com\nvfs.cloud9.eu-west-2.amazonaws.com\nwebview-assets.cloud9.eu-west-2.amazonaws.com\nwebview-assets.aws-cloud9.eu-west-3.amazonaws.com\nvfs.cloud9.eu-west-3.amazonaws.com\nwebview-assets.cloud9.eu-west-3.amazonaws.com\nwebview-assets.aws-cloud9.me-south-1.amazonaws.com\nvfs.cloud9.me-south-1.amazonaws.com\nwebview-assets.cloud9.me-south-1.amazonaws.com\nwebview-assets.aws-cloud9.sa-east-1.amazonaws.com\nvfs.cloud9.sa-east-1.amazonaws.com\nwebview-assets.cloud9.sa-east-1.amazonaws.com\nwebview-assets.aws-cloud9.us-east-1.amazonaws.com\nvfs.cloud9.us-east-1.amazonaws.com\nwebview-assets.cloud9.us-east-1.amazonaws.com\nwebview-assets.aws-cloud9.us-east-2.amazonaws.com\nvfs.cloud9.us-east-2.amazonaws.com\nwebview-assets.cloud9.us-east-2.amazonaws.com\nwebview-assets.aws-cloud9.us-west-1.amazonaws.com\nvfs.cloud9.us-west-1.amazonaws.com\nwebview-assets.cloud9.us-west-1.amazonaws.com\nwebview-assets.aws-cloud9.us-west-2.amazonaws.com\nvfs.cloud9.us-west-2.amazonaws.com\nwebview-assets.cloud9.us-west-2.amazonaws.com\ncn-north-1.eb.amazonaws.com.cn\ncn-northwest-1.eb.amazonaws.com.cn\nelasticbeanstalk.com\naf-south-1.elasticbeanstalk.com\nap-east-1.elasticbeanstalk.com\nap-northeast-1.elasticbeanstalk.com\nap-northeast-2.elasticbeanstalk.com\nap-northeast-3.elasticbeanstalk.com\nap-south-1.elasticbeanstalk.com\nap-southeast-1.elasticbeanstalk.com\nap-southeast-2.elasticbeanstalk.com\nap-southeast-3.elasticbeanstalk.com\nca-central-1.elasticbeanstalk.com\neu-central-1.elasticbeanstalk.com\neu-north-1.elasticbeanstalk.com\neu-south-1.elasticbeanstalk.com\neu-west-1.elasticbeanstalk.com\neu-west-2.elasticbeanstalk.com\neu-west-3.elasticbeanstalk.com\nil-central-1.elasticbeanstalk.com\nme-south-1.elasticbeanstalk.com\nsa-east-1.elasticbeanstalk.com\nus-east-1.elasticbeanstalk.com\nus-east-2.elasticbeanstalk.com\nus-gov-east-1.elasticbeanstalk.com\nus-gov-west-1.elasticbeanstalk.com\nus-west-1.elasticbeanstalk.com\nus-west-2.elasticbeanstalk.com\n*.elb.amazonaws.com.cn\n*.elb.amazonaws.com\nawsglobalaccelerator.com\neero.online\neero-stage.online\nt3l3p0rt.net\ntele.amune.org\napigee.io\nsiiites.com\nappspacehosted.com\nappspaceusercontent.com\nappudo.net\non-aptible.com\nuser.aseinet.ne.jp\ngv.vc\nd.gv.vc\nuser.party.eus\npimienta.org\npoivron.org\npotager.org\nsweetpepper.org\nmyasustor.com\ncdn.prod.atlassian-dev.net\ntranslated.page\nautocode.dev\nmyfritz.net\nonavstack.net\n*.awdev.ca\n*.advisor.ws\necommerce-shop.pl\nb-data.io\nbackplaneapp.io\nbalena-devices.com\nrs.ba\n*.banzai.cloud\napp.banzaicloud.io\n*.backyards.banzaicloud.io\nbase.ec\nofficial.ec\nbuyshop.jp\nfashionstore.jp\nhandcrafted.jp\nkawaiishop.jp\nsupersale.jp\ntheshop.jp\nshopselect.net\nbase.shop\nbeagleboard.io\n*.beget.app\nbetainabox.com\nbnr.la\nbitbucket.io\nblackbaudcdn.net\nof.je\nbluebite.io\nboomla.net\nboutir.com\nboxfuse.io\nsquare7.ch\nbplaced.com\nbplaced.de\nsquare7.de\nbplaced.net\nsquare7.net\nshop.brendly.rs\nbrowsersafetymark.io\nuk0.bigv.io\ndh.bytemark.co.uk\nvm.bytemark.co.uk\ncafjs.com\nmycd.eu\ncanva-apps.cn\ncanva-apps.com\ndrr.ac\nuwu.ai\ncarrd.co\ncrd.co\nju.mp\nae.org\nbr.com\ncn.com\ncom.de\ncom.se\nde.com\neu.com\ngb.net\nhu.net\njp.net\njpn.com\nmex.com\nru.com\nsa.com\nse.net\nuk.com\nuk.net\nus.com\nza.bz\nza.com\nar.com\nhu.com\nkr.com\nno.com\nqc.com\nuy.com\nafrica.com\ngr.com\nin.net\nweb.in\nus.org\nco.com\naus.basketball\nnz.basketball\nradio.am\nradio.fm\nc.la\ncertmgr.org\ncx.ua\ndiscourse.group\ndiscourse.team\ncleverapps.io\nclerk.app\nclerkstage.app\n*.lcl.dev\n*.lclstage.dev\n*.stg.dev\n*.stgstage.dev\nclickrising.net\nc66.me\ncloud66.ws\ncloud66.zone\njdevcloud.com\nwpdevcloud.com\ncloudaccess.host\nfreesite.host\ncloudaccess.net\ncloudcontrolled.com\ncloudcontrolapp.com\n*.cloudera.site\ncf-ipfs.com\ncloudflare-ipfs.com\ntrycloudflare.com\npages.dev\nr2.dev\nworkers.dev\nwnext.app\nco.ca\n*.otap.co\nco.cz\nc.cdn77.org\ncdn77-ssl.net\nr.cdn77.net\nrsc.cdn77.org\nssl.origin.cdn77-secure.org\ncloudns.asia\ncloudns.biz\ncloudns.club\ncloudns.cc\ncloudns.eu\ncloudns.in\ncloudns.info\ncloudns.org\ncloudns.pro\ncloudns.pw\ncloudns.us\ncnpy.gdn\ncodeberg.page\nco.nl\nco.no\nwebhosting.be\nhosting-cluster.nl\nac.ru\nedu.ru\ngov.ru\nint.ru\nmil.ru\ntest.ru\ndyn.cosidns.de\ndynamisches-dns.de\ndnsupdater.de\ninternet-dns.de\nl-o-g-i-n.de\ndynamic-dns.info\nfeste-ip.net\nknx-server.net\nstatic-access.net\nrealm.cz\n*.cryptonomic.net\ncupcake.is\ncurv.dev\n*.customer-oci.com\n*.oci.customer-oci.com\n*.ocp.customer-oci.com\n*.ocs.customer-oci.com\ncyon.link\ncyon.site\nfnwk.site\nfolionetwork.site\nplatform0.app\ndaplie.me\nlocalhost.daplie.me\ndattolocal.com\ndattorelay.com\ndattoweb.com\nmydatto.com\ndattolocal.net\nmydatto.net\nbiz.dk\nco.dk\nfirm.dk\nreg.dk\nstore.dk\ndyndns.dappnode.io\n*.dapps.earth\n*.bzz.dapps.earth\nbuiltwithdark.com\ndemo.datadetect.com\ninstance.datadetect.com\nedgestack.me\nddns5.com\ndebian.net\ndeno.dev\ndeno-staging.dev\ndedyn.io\ndeta.app\ndeta.dev\n*.rss.my.id\n*.diher.solutions\ndiscordsays.com\ndiscordsez.com\njozi.biz\ndnshome.de\nonline.th\nshop.th\ndrayddns.com\nshoparena.pl\ndreamhosters.com\nmydrobo.com\ndrud.io\ndrud.us\nduckdns.org\nbip.sh\nbitbridge.net\ndy.fi\ntunk.org\ndyndns-at-home.com\ndyndns-at-work.com\ndyndns-blog.com\ndyndns-free.com\ndyndns-home.com\ndyndns-ip.com\ndyndns-mail.com\ndyndns-office.com\ndyndns-pics.com\ndyndns-remote.com\ndyndns-server.com\ndyndns-web.com\ndyndns-wiki.com\ndyndns-work.com\ndyndns.biz\ndyndns.info\ndyndns.org\ndyndns.tv\nat-band-camp.net\nath.cx\nbarrel-of-knowledge.info\nbarrell-of-knowledge.info\nbetter-than.tv\nblogdns.com\nblogdns.net\nblogdns.org\nblogsite.org\nboldlygoingnowhere.org\nbroke-it.net\nbuyshouses.net\ncechire.com\ndnsalias.com\ndnsalias.net\ndnsalias.org\ndnsdojo.com\ndnsdojo.net\ndnsdojo.org\ndoes-it.net\ndoesntexist.com\ndoesntexist.org\ndontexist.com\ndontexist.net\ndontexist.org\ndoomdns.com\ndoomdns.org\ndvrdns.org\ndyn-o-saur.com\ndynalias.com\ndynalias.net\ndynalias.org\ndynathome.net\ndyndns.ws\nendofinternet.net\nendofinternet.org\nendoftheinternet.org\nest-a-la-maison.com\nest-a-la-masion.com\nest-le-patron.com\nest-mon-blogueur.com\nfor-better.biz\nfor-more.biz\nfor-our.info\nfor-some.biz\nfor-the.biz\nforgot.her.name\nforgot.his.name\nfrom-ak.com\nfrom-al.com\nfrom-ar.com\nfrom-az.net\nfrom-ca.com\nfrom-co.net\nfrom-ct.com\nfrom-dc.com\nfrom-de.com\nfrom-fl.com\nfrom-ga.com\nfrom-hi.com\nfrom-ia.com\nfrom-id.com\nfrom-il.com\nfrom-in.com\nfrom-ks.com\nfrom-ky.com\nfrom-la.net\nfrom-ma.com\nfrom-md.com\nfrom-me.org\nfrom-mi.com\nfrom-mn.com\nfrom-mo.com\nfrom-ms.com\nfrom-mt.com\nfrom-nc.com\nfrom-nd.com\nfrom-ne.com\nfrom-nh.com\nfrom-nj.com\nfrom-nm.com\nfrom-nv.com\nfrom-ny.net\nfrom-oh.com\nfrom-ok.com\nfrom-or.com\nfrom-pa.com\nfrom-pr.com\nfrom-ri.com\nfrom-sc.com\nfrom-sd.com\nfrom-tn.com\nfrom-tx.com\nfrom-ut.com\nfrom-va.com\nfrom-vt.com\nfrom-wa.com\nfrom-wi.com\nfrom-wv.com\nfrom-wy.com\nftpaccess.cc\nfuettertdasnetz.de\ngame-host.org\ngame-server.cc\ngetmyip.com\ngets-it.net\ngo.dyndns.org\ngotdns.com\ngotdns.org\ngroks-the.info\ngroks-this.info\nham-radio-op.net\nhere-for-more.info\nhobby-site.com\nhobby-site.org\nhome.dyndns.org\nhomedns.org\nhomeftp.net\nhomeftp.org\nhomeip.net\nhomelinux.com\nhomelinux.net\nhomelinux.org\nhomeunix.com\nhomeunix.net\nhomeunix.org\niamallama.com\nin-the-band.net\nis-a-anarchist.com\nis-a-blogger.com\nis-a-bookkeeper.com\nis-a-bruinsfan.org\nis-a-bulls-fan.com\nis-a-candidate.org\nis-a-caterer.com\nis-a-celticsfan.org\nis-a-chef.com\nis-a-chef.net\nis-a-chef.org\nis-a-conservative.com\nis-a-cpa.com\nis-a-cubicle-slave.com\nis-a-democrat.com\nis-a-designer.com\nis-a-doctor.com\nis-a-financialadvisor.com\nis-a-geek.com\nis-a-geek.net\nis-a-geek.org\nis-a-green.com\nis-a-guru.com\nis-a-hard-worker.com\nis-a-hunter.com\nis-a-knight.org\nis-a-landscaper.com\nis-a-lawyer.com\nis-a-liberal.com\nis-a-libertarian.com\nis-a-linux-user.org\nis-a-llama.com\nis-a-musician.com\nis-a-nascarfan.com\nis-a-nurse.com\nis-a-painter.com\nis-a-patsfan.org\nis-a-personaltrainer.com\nis-a-photographer.com\nis-a-player.com\nis-a-republican.com\nis-a-rockstar.com\nis-a-socialist.com\nis-a-soxfan.org\nis-a-student.com\nis-a-teacher.com\nis-a-techie.com\nis-a-therapist.com\nis-an-accountant.com\nis-an-actor.com\nis-an-actress.com\nis-an-anarchist.com\nis-an-artist.com\nis-an-engineer.com\nis-an-entertainer.com\nis-by.us\nis-certified.com\nis-found.org\nis-gone.com\nis-into-anime.com\nis-into-cars.com\nis-into-cartoons.com\nis-into-games.com\nis-leet.com\nis-lost.org\nis-not-certified.com\nis-saved.org\nis-slick.com\nis-uberleet.com\nis-very-bad.org\nis-very-evil.org\nis-very-good.org\nis-very-nice.org\nis-very-sweet.org\nis-with-theband.com\nisa-geek.com\nisa-geek.net\nisa-geek.org\nisa-hockeynut.com\nissmarterthanyou.com\nisteingeek.de\nistmein.de\nkicks-ass.net\nkicks-ass.org\nknowsitall.info\nland-4-sale.us\nlebtimnetz.de\nleitungsen.de\nlikes-pie.com\nlikescandy.com\nmerseine.nu\nmine.nu\nmisconfused.org\nmypets.ws\nmyphotos.cc\nneat-url.com\noffice-on-the.net\non-the-web.tv\npodzone.net\npodzone.org\nreadmyblog.org\nsaves-the-whales.com\nscrapper-site.net\nscrapping.cc\nselfip.biz\nselfip.com\nselfip.info\nselfip.net\nselfip.org\nsells-for-less.com\nsells-for-u.com\nsells-it.net\nsellsyourhome.org\nservebbs.com\nservebbs.net\nservebbs.org\nserveftp.net\nserveftp.org\nservegame.org\nshacknet.nu\nsimple-url.com\nspace-to-rent.com\nstuff-4-sale.org\nstuff-4-sale.us\nteaches-yoga.com\nthruhere.net\ntraeumtgerade.de\nwebhop.biz\nwebhop.info\nwebhop.net\nwebhop.org\nworse-than.tv\nwritesthisblog.com\nddnss.de\ndyn.ddnss.de\ndyndns.ddnss.de\ndyndns1.de\ndyn-ip24.de\nhome-webserver.de\ndyn.home-webserver.de\nmyhome-server.de\nddnss.org\ndefinima.net\ndefinima.io\nondigitalocean.app\n*.digitaloceanspaces.com\nbci.dnstrace.pro\nddnsfree.com\nddnsgeek.com\ngiize.com\ngleeze.com\nkozow.com\nloseyourip.com\nooguy.com\ntheworkpc.com\ncasacam.net\ndynu.net\naccesscam.org\ncamdvr.org\nfreeddns.org\nmywire.org\nwebredirect.org\nmyddns.rocks\nblogsite.xyz\ndynv6.net\ne4.cz\neasypanel.app\neasypanel.host\nelementor.cloud\nelementor.cool\nen-root.fr\nmytuleap.com\ntuleap-partners.com\nencr.app\nencoreapi.com\nonred.one\nstaging.onred.one\neu.encoway.cloud\neu.org\nal.eu.org\nasso.eu.org\nat.eu.org\nau.eu.org\nbe.eu.org\nbg.eu.org\nca.eu.org\ncd.eu.org\nch.eu.org\ncn.eu.org\ncy.eu.org\ncz.eu.org\nde.eu.org\ndk.eu.org\nedu.eu.org\nee.eu.org\nes.eu.org\nfi.eu.org\nfr.eu.org\ngr.eu.org\nhr.eu.org\nhu.eu.org\nie.eu.org\nil.eu.org\nin.eu.org\nint.eu.org\nis.eu.org\nit.eu.org\njp.eu.org\nkr.eu.org\nlt.eu.org\nlu.eu.org\nlv.eu.org\nmc.eu.org\nme.eu.org\nmk.eu.org\nmt.eu.org\nmy.eu.org\nnet.eu.org\nng.eu.org\nnl.eu.org\nno.eu.org\nnz.eu.org\nparis.eu.org\npl.eu.org\npt.eu.org\nq-a.eu.org\nro.eu.org\nru.eu.org\nse.eu.org\nsi.eu.org\nsk.eu.org\ntr.eu.org\nuk.eu.org\nus.eu.org\neurodir.ru\neu-1.evennode.com\neu-2.evennode.com\neu-3.evennode.com\neu-4.evennode.com\nus-1.evennode.com\nus-2.evennode.com\nus-3.evennode.com\nus-4.evennode.com\ntwmail.cc\ntwmail.net\ntwmail.org\nmymailer.com.tw\nurl.tw\nonfabrica.com\napps.fbsbx.com\nru.net\nadygeya.ru\nbashkiria.ru\nbir.ru\ncbg.ru\ncom.ru\ndagestan.ru\ngrozny.ru\nkalmykia.ru\nkustanai.ru\nmarine.ru\nmordovia.ru\nmsk.ru\nmytis.ru\nnalchik.ru\nnov.ru\npyatigorsk.ru\nspb.ru\nvladikavkaz.ru\nvladimir.ru\nabkhazia.su\nadygeya.su\naktyubinsk.su\narkhangelsk.su\narmenia.su\nashgabad.su\nazerbaijan.su\nbalashov.su\nbashkiria.su\nbryansk.su\nbukhara.su\nchimkent.su\ndagestan.su\neast-kazakhstan.su\nexnet.su\ngeorgia.su\ngrozny.su\nivanovo.su\njambyl.su\nkalmykia.su\nkaluga.su\nkaracol.su\nkaraganda.su\nkarelia.su\nkhakassia.su\nkrasnodar.su\nkurgan.su\nkustanai.su\nlenug.su\nmangyshlak.su\nmordovia.su\nmsk.su\nmurmansk.su\nnalchik.su\nnavoi.su\nnorth-kazakhstan.su\nnov.su\nobninsk.su\npenza.su\npokrovsk.su\nsochi.su\nspb.su\ntashkent.su\ntermez.su\ntogliatti.su\ntroitsk.su\ntselinograd.su\ntula.su\ntuva.su\nvladikavkaz.su\nvladimir.su\nvologda.su\nchannelsdvr.net\nu.channelsdvr.net\nedgecompute.app\nfastly-edge.com\nfastly-terrarium.com\nfastlylb.net\nmap.fastlylb.net\nfreetls.fastly.net\nmap.fastly.net\na.prod.fastly.net\nglobal.prod.fastly.net\na.ssl.fastly.net\nb.ssl.fastly.net\nglobal.ssl.fastly.net\n*.user.fm\nfastvps-server.com\nfastvps.host\nmyfast.host\nfastvps.site\nmyfast.space\nfedorainfracloud.org\nfedorapeople.org\ncloud.fedoraproject.org\napp.os.fedoraproject.org\napp.os.stg.fedoraproject.org\nconn.uk\ncopro.uk\nhosp.uk\nmydobiss.com\nfh-muenster.io\nfilegear.me\nfilegear-au.me\nfilegear-de.me\nfilegear-gb.me\nfilegear-ie.me\nfilegear-jp.me\nfilegear-sg.me\nfirebaseapp.com\nfireweb.app\nflap.id\nonflashdrive.app\nfldrv.com\nfly.dev\nedgeapp.net\nshw.io\nflynnhosting.net\nforgeblocks.com\nid.forgerock.io\nframer.app\nframercanvas.com\nframer.media\nframer.photos\nframer.website\nframer.wiki\n*.frusky.de\nravpage.co.il\n0e.vc\nfreebox-os.com\nfreeboxos.com\nfbx-os.fr\nfbxos.fr\nfreebox-os.fr\nfreeboxos.fr\nfreedesktop.org\nfreemyip.com\nwien.funkfeuer.at\n*.futurecms.at\n*.ex.futurecms.at\n*.in.futurecms.at\nfuturehosting.at\nfuturemailing.at\n*.ex.ortsinfo.at\n*.kunden.ortsinfo.at\n*.statics.cloud\nindependent-commission.uk\nindependent-inquest.uk\nindependent-inquiry.uk\nindependent-panel.uk\nindependent-review.uk\npublic-inquiry.uk\nroyal-commission.uk\ncampaign.gov.uk\nservice.gov.uk\napi.gov.uk\ngehirn.ne.jp\nusercontent.jp\ngentapps.com\ngentlentapis.com\nlab.ms\ncdn-edges.net\nghost.io\ngsj.bz\ngithubusercontent.com\ngithubpreview.dev\ngithub.io\ngitlab.io\ngitapp.si\ngitpage.si\nglitch.me\nnog.community\nco.ro\nshop.ro\nlolipop.io\nangry.jp\nbabyblue.jp\nbabymilk.jp\nbackdrop.jp\nbambina.jp\nbitter.jp\nblush.jp\nboo.jp\nboy.jp\nboyfriend.jp\nbut.jp\ncandypop.jp\ncapoo.jp\ncatfood.jp\ncheap.jp\nchicappa.jp\nchillout.jp\nchips.jp\nchowder.jp\nchu.jp\nciao.jp\ncocotte.jp\ncoolblog.jp\ncranky.jp\ncutegirl.jp\ndaa.jp\ndeca.jp\ndeci.jp\ndigick.jp\negoism.jp\nfakefur.jp\nfem.jp\nflier.jp\nfloppy.jp\nfool.jp\nfrenchkiss.jp\ngirlfriend.jp\ngirly.jp\ngloomy.jp\ngonna.jp\ngreater.jp\nhacca.jp\nheavy.jp\nher.jp\nhiho.jp\nhippy.jp\nholy.jp\nhungry.jp\nicurus.jp\nitigo.jp\njellybean.jp\nkikirara.jp\nkill.jp\nkilo.jp\nkuron.jp\nlittlestar.jp\nlolipopmc.jp\nlolitapunk.jp\nlomo.jp\nlovepop.jp\nlovesick.jp\nmain.jp\nmods.jp\nmond.jp\nmongolian.jp\nmoo.jp\nnamaste.jp\nnikita.jp\nnobushi.jp\nnoor.jp\noops.jp\nparallel.jp\nparasite.jp\npecori.jp\npeewee.jp\npenne.jp\npepper.jp\nperma.jp\npigboat.jp\npinoko.jp\npunyu.jp\npupu.jp\npussycat.jp\npya.jp\nraindrop.jp\nreadymade.jp\nsadist.jp\nschoolbus.jp\nsecret.jp\nstaba.jp\nstripper.jp\nsub.jp\nsunnyday.jp\nthick.jp\ntonkotsu.jp\nunder.jp\nupper.jp\nvelvet.jp\nverse.jp\nversus.jp\nvivian.jp\nwatson.jp\nweblike.jp\nwhitesnow.jp\nzombie.jp\nheteml.net\ncloudapps.digital\nlondon.cloudapps.digital\npymnt.uk\nro.im\ngoip.de\nrun.app\na.run.app\nweb.app\n*.0emm.com\nappspot.com\n*.r.appspot.com\ncodespot.com\ngoogleapis.com\ngooglecode.com\npagespeedmobilizer.com\npublishproxy.com\nwithgoogle.com\nwithyoutube.com\n*.gateway.dev\ncloud.goog\ntranslate.goog\n*.usercontent.goog\ncloudfunctions.net\nblogspot.ae\nblogspot.al\nblogspot.am\nblogspot.ba\nblogspot.be\nblogspot.bg\nblogspot.bj\nblogspot.ca\nblogspot.cf\nblogspot.ch\nblogspot.cl\nblogspot.co.at\nblogspot.co.id\nblogspot.co.il\nblogspot.co.ke\nblogspot.co.nz\nblogspot.co.uk\nblogspot.co.za\nblogspot.com\nblogspot.com.ar\nblogspot.com.au\nblogspot.com.br\nblogspot.com.by\nblogspot.com.co\nblogspot.com.cy\nblogspot.com.ee\nblogspot.com.eg\nblogspot.com.es\nblogspot.com.mt\nblogspot.com.ng\nblogspot.com.tr\nblogspot.com.uy\nblogspot.cv\nblogspot.cz\nblogspot.de\nblogspot.dk\nblogspot.fi\nblogspot.fr\nblogspot.gr\nblogspot.hk\nblogspot.hr\nblogspot.hu\nblogspot.ie\nblogspot.in\nblogspot.is\nblogspot.it\nblogspot.jp\nblogspot.kr\nblogspot.li\nblogspot.lt\nblogspot.lu\nblogspot.md\nblogspot.mk\nblogspot.mr\nblogspot.mx\nblogspot.my\nblogspot.nl\nblogspot.no\nblogspot.pe\nblogspot.pt\nblogspot.qa\nblogspot.re\nblogspot.ro\nblogspot.rs\nblogspot.ru\nblogspot.se\nblogspot.sg\nblogspot.si\nblogspot.sk\nblogspot.sn\nblogspot.td\nblogspot.tw\nblogspot.ug\nblogspot.vn\ngoupile.fr\ngov.nl\nawsmppl.com\nxn--gnstigbestellen-zvb.de\nxn--gnstigliefern-wob.de\nfin.ci\nfree.hr\ncaa.li\nua.rs\nconf.se\nhs.zone\nhs.run\nhashbang.sh\nhasura.app\nhasura-app.io\npages.it.hs-heilbronn.de\nhepforge.org\nherokuapp.com\nherokussl.com\nravendb.cloud\nravendb.community\nravendb.me\ndevelopment.run\nravendb.run\nhomesklep.pl\nsecaas.hk\nhoplix.shop\norx.biz\nbiz.gl\ncol.ng\nfirm.ng\ngen.ng\nltd.ng\nngo.ng\nedu.scot\nsch.so\nie.ua\nhostyhosting.io\nxn--hkkinen-5wa.fi\n*.moonscale.io\nmoonscale.net\niki.fi\nibxos.it\niliadboxos.it\nimpertrixcdn.com\nimpertrix.com\nsmushcdn.com\nwphostedmail.com\nwpmucdn.com\ntempurl.host\nwpmudev.host\ndyn-berlin.de\nin-berlin.de\nin-brb.de\nin-butter.de\nin-dsl.de\nin-dsl.net\nin-dsl.org\nin-vpn.de\nin-vpn.net\nin-vpn.org\nbiz.at\ninfo.at\ninfo.cx\nac.leg.br\nal.leg.br\nam.leg.br\nap.leg.br\nba.leg.br\nce.leg.br\ndf.leg.br\nes.leg.br\ngo.leg.br\nma.leg.br\nmg.leg.br\nms.leg.br\nmt.leg.br\npa.leg.br\npb.leg.br\npe.leg.br\npi.leg.br\npr.leg.br\nrj.leg.br\nrn.leg.br\nro.leg.br\nrr.leg.br\nrs.leg.br\nsc.leg.br\nse.leg.br\nsp.leg.br\nto.leg.br\npixolino.com\nna4u.ru\niopsys.se\nipifony.net\niservschule.de\nmein-iserv.de\nschulplattform.de\nschulserver.de\ntest-iserv.de\niserv.dev\niobb.net\nmel.cloudlets.com.au\ncloud.interhostsolutions.be\nmycloud.by\nalp1.ae.flow.ch\nappengine.flow.ch\nes-1.axarnet.cloud\ndiadem.cloud\nvip.jelastic.cloud\njele.cloud\nit1.eur.aruba.jenv-aruba.cloud\nit1.jenv-aruba.cloud\nkeliweb.cloud\ncs.keliweb.cloud\noxa.cloud\ntn.oxa.cloud\nuk.oxa.cloud\nprimetel.cloud\nuk.primetel.cloud\nca.reclaim.cloud\nuk.reclaim.cloud\nus.reclaim.cloud\nch.trendhosting.cloud\nde.trendhosting.cloud\njele.club\namscompute.com\ndopaas.com\npaas.hosted-by-previder.com\nrag-cloud.hosteur.com\nrag-cloud-ch.hosteur.com\njcloud.ik-server.com\njcloud-ver-jpc.ik-server.com\ndemo.jelastic.com\nkilatiron.com\npaas.massivegrid.com\njed.wafaicloud.com\nlon.wafaicloud.com\nryd.wafaicloud.com\nj.scaleforce.com.cy\njelastic.dogado.eu\nfi.cloudplatform.fi\ndemo.datacenter.fi\npaas.datacenter.fi\njele.host\nmircloud.host\npaas.beebyte.io\nsekd1.beebyteapp.io\njele.io\ncloud-fr1.unispace.io\njc.neen.it\ncloud.jelastic.open.tim.it\njcloud.kz\nupaas.kazteleport.kz\ncloudjiffy.net\nfra1-de.cloudjiffy.net\nwest1-us.cloudjiffy.net\njls-sto1.elastx.net\njls-sto2.elastx.net\njls-sto3.elastx.net\nfaststacks.net\nfr-1.paas.massivegrid.net\nlon-1.paas.massivegrid.net\nlon-2.paas.massivegrid.net\nny-1.paas.massivegrid.net\nny-2.paas.massivegrid.net\nsg-1.paas.massivegrid.net\njelastic.saveincloud.net\nnordeste-idc.saveincloud.net\nj.scaleforce.net\njelastic.tsukaeru.net\nsdscloud.pl\nunicloud.pl\nmircloud.ru\njelastic.regruhosting.ru\nenscaled.sg\njele.site\njelastic.team\norangecloud.tn\nj.layershift.co.uk\nphx.enscaled.us\nmircloud.us\nmyjino.ru\n*.hosting.myjino.ru\n*.landing.myjino.ru\n*.spectrum.myjino.ru\n*.vps.myjino.ru\njotelulu.cloud\n*.triton.zone\n*.cns.joyent.com\njs.org\nkaas.gg\nkhplay.nl\nktistory.com\nkapsi.fi\nkeymachine.de\nkinghost.net\nuni5.net\nknightpoint.systems\nkoobin.events\noya.to\nkuleuven.cloud\nezproxy.kuleuven.be\nco.krd\nedu.krd\nkrellian.net\nwebthings.io\ngit-repos.de\nlcube-server.de\nsvn-repos.de\nleadpages.co\nlpages.co\nlpusercontent.com\nlelux.site\nco.business\nco.education\nco.events\nco.financial\nco.network\nco.place\nco.technology\napp.lmpm.com\nlinkyard.cloud\nlinkyard-cloud.ch\nmembers.linode.com\n*.nodebalancer.linode.com\n*.linodeobjects.com\nip.linodeusercontent.com\nwe.bs\n*.user.localcert.dev\nlocalzone.xyz\nloginline.app\nloginline.dev\nloginline.io\nloginline.services\nloginline.site\nservers.run\nlohmus.me\nkrasnik.pl\nleczna.pl\nlubartow.pl\nlublin.pl\nponiatowa.pl\nswidnik.pl\nglug.org.uk\nlug.org.uk\nlugs.org.uk\nbarsy.bg\nbarsy.co.uk\nbarsyonline.co.uk\nbarsycenter.com\nbarsyonline.com\nbarsy.club\nbarsy.de\nbarsy.eu\nbarsy.in\nbarsy.info\nbarsy.io\nbarsy.me\nbarsy.menu\nbarsy.mobi\nbarsy.net\nbarsy.online\nbarsy.org\nbarsy.pro\nbarsy.pub\nbarsy.ro\nbarsy.shop\nbarsy.site\nbarsy.support\nbarsy.uk\n*.magentosite.cloud\nmayfirst.info\nmayfirst.org\nhb.cldmail.ru\ncn.vu\nmazeplay.com\nmcpe.me\nmcdir.me\nmcdir.ru\nmcpre.ru\nvps.mcdir.ru\nmediatech.by\nmediatech.dev\nhra.health\nminiserver.com\nmemset.net\nmesserli.app\n*.cloud.metacentrum.cz\ncustom.metacentrum.cz\nflt.cloud.muni.cz\nusr.cloud.muni.cz\nmeteorapp.com\neu.meteorapp.com\nco.pl\n*.azurecontainer.io\nazurewebsites.net\nazure-mobile.net\ncloudapp.net\nazurestaticapps.net\n1.azurestaticapps.net\n2.azurestaticapps.net\n3.azurestaticapps.net\n4.azurestaticapps.net\n5.azurestaticapps.net\n6.azurestaticapps.net\n7.azurestaticapps.net\ncentralus.azurestaticapps.net\neastasia.azurestaticapps.net\neastus2.azurestaticapps.net\nwesteurope.azurestaticapps.net\nwestus2.azurestaticapps.net\ncsx.cc\nmintere.site\nforte.id\nmozilla-iot.org\nbmoattachments.org\nnet.ru\norg.ru\npp.ru\nhostedpi.com\ncustomer.mythic-beasts.com\ncaracal.mythic-beasts.com\nfentiger.mythic-beasts.com\nlynx.mythic-beasts.com\nocelot.mythic-beasts.com\noncilla.mythic-beasts.com\nonza.mythic-beasts.com\nsphinx.mythic-beasts.com\nvs.mythic-beasts.com\nx.mythic-beasts.com\nyali.mythic-beasts.com\ncust.retrosnub.co.uk\nui.nabu.casa\ncloud.nospamproxy.com\nnetlify.app\n4u.com\nngrok.app\nngrok-free.app\nngrok.dev\nngrok-free.dev\nngrok.io\nap.ngrok.io\nau.ngrok.io\neu.ngrok.io\nin.ngrok.io\njp.ngrok.io\nsa.ngrok.io\nus.ngrok.io\nngrok.pizza\ntorun.pl\nnh-serv.co.uk\nnfshost.com\n*.developer.app\nnoop.app\n*.northflank.app\n*.build.run\n*.code.run\n*.database.run\n*.migration.run\nnoticeable.news\ndnsking.ch\nmypi.co\nn4t.co\n001www.com\nddnslive.com\nmyiphost.com\nforumz.info\n16-b.it\n32-b.it\n64-b.it\nsoundcast.me\ntcp4.me\ndnsup.net\nhicam.net\nnow-dns.net\nownip.net\nvpndns.net\ndynserv.org\nnow-dns.org\nx443.pw\nnow-dns.top\nntdll.top\nfreeddns.us\ncrafting.xyz\nzapto.xyz\nnsupdate.info\nnerdpol.ovh\nblogsyte.com\nbrasilia.me\ncable-modem.org\nciscofreak.com\ncollegefan.org\ncouchpotatofries.org\ndamnserver.com\nddns.me\nditchyourip.com\ndnsfor.me\ndnsiskinky.com\ndvrcam.info\ndynns.com\neating-organic.net\nfantasyleague.cc\ngeekgalaxy.com\ngolffan.us\nhealth-carereform.com\nhomesecuritymac.com\nhomesecuritypc.com\nhopto.me\nilovecollege.info\nloginto.me\nmlbfan.org\nmmafan.biz\nmyactivedirectory.com\nmydissent.net\nmyeffect.net\nmymediapc.net\nmypsx.net\nmysecuritycamera.com\nmysecuritycamera.net\nmysecuritycamera.org\nnet-freaks.com\nnflfan.org\nnhlfan.net\nno-ip.ca\nno-ip.co.uk\nno-ip.net\nnoip.us\nonthewifi.com\npgafan.net\npoint2this.com\npointto.us\nprivatizehealthinsurance.net\nquicksytes.com\nread-books.org\nsecuritytactics.com\nserveexchange.com\nservehumour.com\nservep2p.com\nservesarcasm.com\nstufftoread.com\nufcfan.org\nunusualperson.com\nworkisboring.com\n3utilities.com\nbounceme.net\nddns.net\nddnsking.com\ngotdns.ch\nhopto.org\nmyftp.biz\nmyftp.org\nmyvnc.com\nno-ip.biz\nno-ip.info\nno-ip.org\nnoip.me\nredirectme.net\nservebeer.com\nserveblog.net\nservecounterstrike.com\nserveftp.com\nservegame.com\nservehalflife.com\nservehttp.com\nserveirc.com\nserveminecraft.net\nservemp3.com\nservepics.com\nservequake.com\nsytes.net\nwebhop.me\nzapto.org\nstage.nodeart.io\npcloud.host\nnyc.mn\nstatic.observableusercontent.com\ncya.gg\nomg.lol\ncloudycluster.net\nomniwe.site\n123hjemmeside.dk\n123hjemmeside.no\n123homepage.it\n123kotisivu.fi\n123minsida.se\n123miweb.es\n123paginaweb.pt\n123sait.ru\n123siteweb.fr\n123webseite.at\n123webseite.de\n123website.be\n123website.ch\n123website.lu\n123website.nl\nservice.one\nsimplesite.com\nsimplesite.com.br\nsimplesite.gr\nsimplesite.pl\nnid.io\nopensocial.site\nopencraft.hosting\norsites.com\noperaunite.com\ntech.orange\nauthgear-staging.com\nauthgearapps.com\nskygearapp.com\noutsystemscloud.com\n*.webpaas.ovh.net\n*.hosting.ovh.net\nownprovider.com\nown.pm\n*.owo.codes\nox.rs\noy.lc\npgfog.com\npagefrontapp.com\npagexl.com\n*.paywhirl.com\nbar0.net\nbar1.net\nbar2.net\nrdv.to\nart.pl\ngliwice.pl\nkrakow.pl\npoznan.pl\nwroc.pl\nzakopane.pl\npantheonsite.io\ngotpantheon.com\nmypep.link\nperspecta.cloud\nlk3.ru\non-web.fr\nbc.platform.sh\nent.platform.sh\neu.platform.sh\nus.platform.sh\n*.platformsh.site\n*.tst.site\nplatter-app.com\nplatter-app.dev\nplatterp.us\npdns.page\nplesk.page\npleskns.com\ndyn53.io\nonporter.run\nco.bn\npostman-echo.com\npstmn.io\nmock.pstmn.io\nhttpbin.org\nprequalifyme.today\nxen.prgmr.com\npriv.at\nprvcy.page\n*.dweb.link\nprotonet.io\nchirurgiens-dentistes-en-france.fr\nbyen.site\npubtls.org\npythonanywhere.com\neu.pythonanywhere.com\nqoto.io\nqualifioapp.com\nladesk.com\nqbuser.com\ncloudsite.builders\ninstances.spawn.cc\ninstantcloud.cn\nras.ru\nqa2.com\nqcx.io\n*.sys.qcx.io\ndev-myqnapcloud.com\nalpha-myqnapcloud.com\nmyqnapcloud.com\n*.quipelements.com\nvapor.cloud\nvaporcloud.io\nrackmaze.com\nrackmaze.net\ng.vbrplsbx.io\n*.on-k3s.io\n*.on-rancher.cloud\n*.on-rio.io\nreadthedocs.io\nrhcloud.com\napp.render.com\nonrender.com\nfirewalledreplit.co\nid.firewalledreplit.co\nrepl.co\nid.repl.co\nrepl.run\nresindevice.io\ndevices.resinstaging.io\nhzc.io\nwellbeingzone.eu\nwellbeingzone.co.uk\nadimo.co.uk\nitcouldbewor.se\ngit-pages.rit.edu\nrocky.page\nxn--90amc.xn--p1acf\nxn--j1aef.xn--p1acf\nxn--j1ael8b.xn--p1acf\nxn--h1ahn.xn--p1acf\nxn--j1adp.xn--p1acf\nxn--c1avg.xn--p1acf\nxn--80aaa0cvac.xn--p1acf\nxn--h1aliz.xn--p1acf\nxn--90a1af.xn--p1acf\nxn--41a.xn--p1acf\n180r.com\ndojin.com\nsakuratan.com\nsakuraweb.com\nx0.com\n2-d.jp\nbona.jp\ncrap.jp\ndaynight.jp\neek.jp\nflop.jp\nhalfmoon.jp\njeez.jp\nmatrix.jp\nmimoza.jp\nivory.ne.jp\nmail-box.ne.jp\nmints.ne.jp\nmokuren.ne.jp\nopal.ne.jp\nsakura.ne.jp\nsumomo.ne.jp\ntopaz.ne.jp\nnetgamers.jp\nnyanta.jp\no0o0.jp\nrdy.jp\nrgr.jp\nrulez.jp\ns3.isk01.sakurastorage.jp\ns3.isk02.sakurastorage.jp\nsaloon.jp\nsblo.jp\nskr.jp\ntank.jp\nuh-oh.jp\nundo.jp\nrs.webaccel.jp\nuser.webaccel.jp\nwebsozai.jp\nxii.jp\nsquares.net\njpn.org\nkirara.st\nx0.to\nfrom.tv\nsakura.tv\n*.builder.code.com\n*.dev-builder.code.com\n*.stg-builder.code.com\nsandcats.io\nlogoip.de\nlogoip.com\nfr-par-1.baremetal.scw.cloud\nfr-par-2.baremetal.scw.cloud\nnl-ams-1.baremetal.scw.cloud\nfnc.fr-par.scw.cloud\nfunctions.fnc.fr-par.scw.cloud\nk8s.fr-par.scw.cloud\nnodes.k8s.fr-par.scw.cloud\ns3.fr-par.scw.cloud\ns3-website.fr-par.scw.cloud\nwhm.fr-par.scw.cloud\npriv.instances.scw.cloud\npub.instances.scw.cloud\nk8s.scw.cloud\nk8s.nl-ams.scw.cloud\nnodes.k8s.nl-ams.scw.cloud\ns3.nl-ams.scw.cloud\ns3-website.nl-ams.scw.cloud\nwhm.nl-ams.scw.cloud\nk8s.pl-waw.scw.cloud\nnodes.k8s.pl-waw.scw.cloud\ns3.pl-waw.scw.cloud\ns3-website.pl-waw.scw.cloud\nscalebook.scw.cloud\nsmartlabeling.scw.cloud\ndedibox.fr\nschokokeks.net\ngov.scot\nservice.gov.scot\nscrysec.com\nfirewall-gateway.com\nfirewall-gateway.de\nmy-gateway.de\nmy-router.de\nspdns.de\nspdns.eu\nfirewall-gateway.net\nmy-firewall.org\nmyfirewall.org\nspdns.org\nseidat.net\nsellfy.store\nsenseering.net\nminisite.ms\nmagnet.page\nbiz.ua\nco.ua\npp.ua\nshiftcrypto.dev\nshiftcrypto.io\nshiftedit.io\nmyshopblocks.com\nmyshopify.com\nshopitsite.com\nshopware.store\nmo-siemens.io\n1kapp.com\nappchizi.com\napplinzi.com\nsinaapp.com\nvipsinaapp.com\nsiteleaf.net\nbounty-full.com\nalpha.bounty-full.com\nbeta.bounty-full.com\naeroport.fr\navocat.fr\nchambagri.fr\nchirurgiens-dentistes.fr\nexperts-comptables.fr\nmedecin.fr\nnotaires.fr\npharmacien.fr\nport.fr\nveterinaire.fr\nsmall-web.org\nvp4.me\nsnowflake.app\nprivatelink.snowflake.app\nstreamlit.app\nstreamlitapp.com\ntry-snowplow.com\nsrht.site\nstackhero-network.com\nmusician.io\nnovecore.site\nstatic.land\ndev.static.land\nsites.static.land\nstorebase.store\nvps-host.net\natl.jelastic.vps-host.net\nnjs.jelastic.vps-host.net\nric.jelastic.vps-host.net\nplaystation-cloud.com\napps.lair.io\n*.stolos.io\nspacekit.io\ncustomer.speedpartner.de\nmyspreadshop.at\nmyspreadshop.com.au\nmyspreadshop.be\nmyspreadshop.ca\nmyspreadshop.ch\nmyspreadshop.com\nmyspreadshop.de\nmyspreadshop.dk\nmyspreadshop.es\nmyspreadshop.fi\nmyspreadshop.fr\nmyspreadshop.ie\nmyspreadshop.it\nmyspreadshop.net\nmyspreadshop.nl\nmyspreadshop.no\nmyspreadshop.pl\nmyspreadshop.se\nmyspreadshop.co.uk\napi.stdlib.com\nstoripress.app\nstorj.farm\nutwente.io\nsoc.srcf.net\nuser.srcf.net\ntemp-dns.com\nsupabase.co\nsupabase.in\nsupabase.net\nsu.paba.se\n*.s5y.io\n*.sensiosite.cloud\nsyncloud.it\ndscloud.biz\ndirect.quickconnect.cn\ndsmynas.com\nfamilyds.com\ndiskstation.me\ndscloud.me\ni234.me\nmyds.me\nsynology.me\ndscloud.mobi\ndsmynas.net\nfamilyds.net\ndsmynas.org\nfamilyds.org\nvpnplus.to\ndirect.quickconnect.to\ntabitorder.co.il\nmytabit.co.il\nmytabit.com\ntaifun-dns.de\nbeta.tailscale.net\nts.net\ngda.pl\ngdansk.pl\ngdynia.pl\nmed.pl\nsopot.pl\nsite.tb-hosting.com\nedugit.io\ns3.teckids.org\ntelebit.app\ntelebit.io\n*.telebit.xyz\n*.firenet.ch\n*.svc.firenet.ch\nreservd.com\nthingdustdata.com\ncust.dev.thingdust.io\ncust.disrec.thingdust.io\ncust.prod.thingdust.io\ncust.testing.thingdust.io\nreservd.dev.thingdust.io\nreservd.disrec.thingdust.io\nreservd.testing.thingdust.io\ntickets.io\narvo.network\nazimuth.network\ntlon.network\ntorproject.net\npages.torproject.net\nbloxcms.com\ntownnews-staging.com\n12hp.at\n2ix.at\n4lima.at\nlima-city.at\n12hp.ch\n2ix.ch\n4lima.ch\nlima-city.ch\ntrafficplex.cloud\nde.cool\n12hp.de\n2ix.de\n4lima.de\nlima-city.de\n1337.pictures\nclan.rip\nlima-city.rocks\nwebspace.rocks\nlima.zone\n*.transurl.be\n*.transurl.eu\n*.transurl.nl\nsite.transip.me\ntuxfamily.org\ndd-dns.de\ndiskstation.eu\ndiskstation.org\ndray-dns.de\ndraydns.de\ndyn-vpn.de\ndynvpn.de\nmein-vigor.de\nmy-vigor.de\nmy-wan.de\nsyno-ds.de\nsynology-diskstation.de\nsynology-ds.de\ntypedream.app\npro.typeform.com\nuber.space\n*.uberspace.de\nhk.com\nhk.org\nltd.hk\ninc.hk\nit.com\nname.pm\nsch.tf\nbiz.wf\nsch.wf\norg.yt\nvirtualuser.de\nvirtual-user.de\nupli.io\nurown.cloud\ndnsupdate.info\nlib.de.us\n2038.io\nvercel.app\nvercel.dev\nnow.sh\nrouter.management\nv-info.info\nvoorloper.cloud\nneko.am\nnyaa.am\nbe.ax\ncat.ax\nes.ax\neu.ax\ngg.ax\nmc.ax\nus.ax\nxy.ax\nnl.ci\nxx.gl\napp.gp\nblog.gt\nde.gt\nto.gt\nbe.gy\ncc.hn\nblog.kg\nio.kg\njp.kg\ntv.kg\nuk.kg\nus.kg\nde.ls\nat.md\nde.md\njp.md\nto.md\nindie.porn\nvxl.sh\nch.tc\nme.tc\nwe.tc\nnyan.to\nat.vg\nblog.vu\ndev.vu\nme.vu\nv.ua\n*.vultrobjects.com\nwafflecell.com\n*.webhare.dev\nreserve-online.net\nreserve-online.com\nbookonline.app\nhotelwithflight.com\nwedeploy.io\nwedeploy.me\nwedeploy.sh\nremotewd.com\npages.wiardweb.com\nwmflabs.org\ntoolforge.org\nwmcloud.org\npanel.gg\ndaemon.panel.gg\nmesswithdns.com\nwoltlab-demo.com\nmyforum.community\ncommunity-pro.de\ndiskussionsbereich.de\ncommunity-pro.net\nmeinforum.net\naffinitylottery.org.uk\nraffleentry.org.uk\nweeklylottery.org.uk\nwpenginepowered.com\njs.wpenginepowered.com\nwixsite.com\neditorx.io\nwixstudio.io\nwix.run\nhalf.host\nxnbay.com\nu2.xnbay.com\nu2-local.xnbay.com\ncistron.nl\ndemon.nl\nxs4all.space\nyandexcloud.net\nstorage.yandexcloud.net\nwebsite.yandexcloud.net\nofficial.academy\nyolasite.com\nybo.faith\nyombo.me\nhomelink.one\nybo.party\nybo.review\nybo.science\nybo.trade\nynh.fr\nnohost.me\nnoho.st\nza.net\nza.org\nbss.design\nbasicserver.io\nvirtualserver.io\nenterprisecloud.nu';

// ===== glue/cookies.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin's cookies (docs/cookies.md): RFC 6265bis (draft-ietf-httpbis-rfc6265bis-20) as Chrome keeps it. One file for the
// segment's jar (bundled into the engine glue, in the realm page code shares, so every builtin is captured below before any
// page script runs) and for the carapace's store (build/cookies.mjs wraps this file as a module). Needs PSL_RULES
// (tools/psl-gen.py) in scope.
//
//   parseSetCookie(string, nowMs)          a set-cookie-string -> a parsed record, or null (6265bis 5.6)
//   registrableDomain(host)                eTLD+1 by the Public Suffix List (private rules included, as Chrome), or the host
//   createJar(config)                      the segment's jar: header(url, ctx), store(url, string, ctx), forScript(url), apply()
//   bucketOf(cookie), cookieKey(cookie)    how the carapace files a record
//   checkRecord(record)                    a clean copy of a record a segment sent, or null
//
// A cookie record (plain data; the carapace persists it, segments receive it):
//   { name, value, domain, hostOnly, path, expires (ms since the epoch, or null for a session cookie), secure, httpOnly,
//     sameSite ('strict' | 'lax' | 'none' | 'unspecified'), partitionKey ('' or '<scheme>://<site> <0|1>'), partitioned,
//     site (the registrable domain of `domain`), created, lastAccess }
// Buckets: '' is the unpartitioned jar of `site`; a partition key alone holds Partitioned (CHIPS) cookies; a partition key
// followed by '\tu' holds the cookies a third-party response set without Partitioned in that partition (docs/cookies.md,
// "Third-party cookies": they never reach the site's own jar, because the segment that received them is another site's).

const ChitinCookies = (function () {
    'use strict';
    const G = globalThis;
    const uncurry = G.Function.prototype.bind.bind(G.Function.prototype.call);
    const S = G.String;
    const StrSlice = uncurry(S.prototype.slice);
    const StrIndexOf = uncurry(S.prototype.indexOf);
    const StrLastIndexOf = uncurry(S.prototype.lastIndexOf);
    const StrCharCodeAt = uncurry(S.prototype.charCodeAt);
    const StrToLower = uncurry(S.prototype.toLowerCase);
    const StrSplit = uncurry(S.prototype.split);
    const StrStartsWith = uncurry(S.prototype.startsWith);
    const StrEndsWith = uncurry(S.prototype.endsWith);
    const RegExpExec = uncurry(G.RegExp.prototype.exec);
    const ArraySort = uncurry(G.Array.prototype.sort);
    const ObjectSetPrototypeOf = G.Object.setPrototypeOf;
    const ObjectFreeze = G.Object.freeze;
    const ObjectKeys = G.Object.keys;
    const NumberIsFinite = G.Number.isFinite;
    const NumberParseInt = G.Number.parseInt;
    const MathFloor = G.Math.floor;
    const DateNow = G.Date.now;
    const HostDate = G.Date;
    const DateUTC = G.Date.UTC;
    const DateGetUTCDate = uncurry(G.Date.prototype.getUTCDate);
    const hostQueueMicrotask = typeof G.queueMicrotask === 'function' ? G.queueMicrotask : null;
    const HostMap = G.Map;
    const MapGet = uncurry(HostMap.prototype.get);
    const MapSet = uncurry(HostMap.prototype.set);
    const MapHas = uncurry(HostMap.prototype.has);
    const MapDelete = uncurry(HostMap.prototype.delete);
    const MapForEach = uncurry(HostMap.prototype.forEach);
    const MapClear = uncurry(HostMap.prototype.clear);
    const MapSize = uncurry(G.Object.getOwnPropertyDescriptor(HostMap.prototype, 'size').get);
    const arr = () => ObjectSetPrototypeOf([], null);
    // A list handed to the host's own code: filled while it had no prototype (no page setter saw a write), then an Array.
    const ArrayProto = G.Array.prototype;
    const toArray = (a) => ObjectSetPrototypeOf(a, ArrayProto);
    const obj = () => ObjectSetPrototypeOf({}, null);
    const push = (a, v) => { a[a.length] = v; };

    // Chrome's limits (net/cookies/cookie_monster.h, cookie_constants.h, canonical_cookie.cc).
    const MAX_NAME_VALUE = 4096;
    const MAX_ATTRIBUTE_VALUE = 1024;
    const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
    const DOMAIN_MAX = 180, DOMAIN_PURGE = 30;
    const TOTAL_MAX = 3300, TOTAL_PURGE = 300;
    const PARTITION_MAX_BYTES = 10240;
    const LAX_ALLOW_UNSAFE_MS = 2 * 60 * 1000;
    const EARLIEST = 0;

    // --- The Public Suffix List ------------------------------------------------------------------------------------------
    const rules = new HostMap();      // rule -> 1 (normal), 2 (wildcard: '*.' + rule), 3 (exception)
    {
        const list = StrSplit(PSL_RULES, '\n');
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (StrStartsWith(r, '!'))
                MapSet(rules, StrSlice(r, 1), 3);
            else if (StrStartsWith(r, '*.'))
                MapSet(rules, '*.' + StrSlice(r, 2), 2);
            else
                MapSet(rules, r, 1);
        }
    }
    const isIp = (host) => RegExpExec(/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/, host) !== null || StrStartsWith(host, '[');
    // The number of labels of the public suffix of `host` (PSL algorithm; the default rule '*' makes it at least 1).
    function suffixLabels(labels) {
        let best = 1;
        for (let i = 0; i < labels.length; i++) {
            let name = labels[i];
            for (let j = i + 1; j < labels.length; j++)
                name += '.' + labels[j];
            const n = labels.length - i;
            if (MapGet(rules, name) === 3)
                return n - 1;
            if (MapGet(rules, name) === 1 && n > best)
                best = n;
            if (i > 0 && n + 1 > best) {
                let parent = labels[i];
                for (let j = i + 1; j < labels.length; j++)
                    parent += '.' + labels[j];
                if (MapGet(rules, '*.' + parent) === 2 && n + 1 > best)
                    best = n + 1;
            }
        }
        return best;
    }
    function labelsOf(host) {
        let h = StrToLower(S(host));
        if (StrEndsWith(h, '.'))
            h = StrSlice(h, 0, -1);
        return StrSplit(h, '.');
    }
    // eTLD+1, or the host itself when it is an IP literal, a public suffix or has a single label.
    function registrableDomain(host) {
        host = StrToLower(S(host));
        if (StrEndsWith(host, '.'))
            host = StrSlice(host, 0, -1);
        if (host === '' || isIp(host))
            return host;
        const labels = labelsOf(host);
        const n = suffixLabels(labels);
        if (labels.length <= n)
            return host;
        let out = labels[labels.length - n - 1];
        for (let j = labels.length - n; j < labels.length; j++)
            out += '.' + labels[j];
        return out;
    }
    function isPublicSuffix(domain) {
        domain = StrToLower(S(domain));
        if (domain === '' || isIp(domain))
            return false;
        const labels = labelsOf(domain);
        return suffixLabels(labels) >= labels.length;
    }

    // --- URLs ------------------------------------------------------------------------------------------------------------
    // The URLs here are serialized by a URL parser (the engine's, the host's): scheme, host in its canonical ASCII form.
    const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?([^?#]*)/;
    function parseUrl(url) {
        const m = RegExpExec(URL_RE, S(url));
        if (m === null)
            return null;
        let scheme = StrToLower(m[1]);
        if (scheme === 'ws')
            scheme = 'http';
        else if (scheme === 'wss')
            scheme = 'https';
        if (scheme !== 'http' && scheme !== 'https')
            return null;
        let host = StrToLower(m[2]);
        if (StrEndsWith(host, '.'))
            host = StrSlice(host, 0, -1);
        if (host === '')
            return null;
        let path = m[4] || '/';
        if (path === '')
            path = '/';
        return { __proto__: null, scheme, host, path, secure: scheme === 'https' || isLoopbackHost(host) };
    }
    // Chrome treats http://localhost and loopback addresses as potentially trustworthy: Secure cookies may be set and sent there.
    function isLoopbackHost(host) {
        return host === 'localhost' || StrEndsWith(host, '.localhost') || RegExpExec(/^127\.[0-9]+\.[0-9]+\.[0-9]+$/, host) !== null || host === '[::1]';
    }
    // The schemeful site of a URL (Chrome's SchemefulSite): scheme and registrable domain.
    function schemefulSite(url) {
        const u = typeof url === 'string' ? parseUrl(url) : url;
        return u ? u.scheme + '://' + registrableDomain(u.host) : null;
    }

    // --- Parsing a set-cookie-string (6265bis 5.6) ----------------------------------------------------------------------
    const isWsp = (c) => c === 0x20 || c === 0x09;
    function trimWsp(s) {
        let a = 0, b = s.length;
        while (a < b && isWsp(StrCharCodeAt(s, a)))
            a++;
        while (b > a && isWsp(StrCharCodeAt(s, b - 1)))
            b--;
        return StrSlice(s, a, b);
    }
    // A control character other than HTAB anywhere makes Chrome refuse the whole cookie (CookieControlCharacters).
    function hasControl(s) {
        for (let i = 0; i < s.length; i++) {
            const c = StrCharCodeAt(s, i);
            if ((c < 0x20 && c !== 0x09) || c === 0x7f)
                return true;
        }
        return false;
    }

    // The cookie-date algorithm (6265bis 5.4.1); returns ms since the epoch or null.
    const MONTHS = ObjectFreeze(ObjectSetPrototypeOf(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], null));
    function isDelimiter(c) {
        return c === 0x09 || (c >= 0x20 && c <= 0x2f) || (c >= 0x3b && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
    }
    function parseCookieDate(s) {
        const tokens = arr();
        let cur = '';
        for (let i = 0; i <= s.length; i++) {
            const c = i < s.length ? StrCharCodeAt(s, i) : 0x20;
            if (isDelimiter(c)) {
                if (cur !== '')
                    push(tokens, cur);
                cur = '';
            } else {
                cur += s[i];
            }
        }
        let time = null, day = null, month = null, year = null;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            let m;
            if (time === null && (m = RegExpExec(/^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[^\d].*)?$/, t)) !== null) {
                time = [+m[1], +m[2], +m[3]];
                continue;
            }
            if (day === null && (m = RegExpExec(/^(\d{1,2})(?:[^\d].*)?$/, t)) !== null) {
                day = +m[1];
                continue;
            }
            if (month === null && t.length >= 3) {
                const p3 = StrToLower(StrSlice(t, 0, 3));
                let idx = -1;
                for (let k = 0; k < 12; k++)
                    if (MONTHS[k] === p3)
                        idx = k;
                if (idx >= 0) {
                    month = idx;
                    continue;
                }
            }
            if (year === null && (m = RegExpExec(/^(\d{2,4})(?:[^\d].*)?$/, t)) !== null) {
                year = +m[1];
                continue;
            }
        }
        if (year !== null) {
            if (year >= 70 && year <= 99)
                year += 1900;
            else if (year >= 0 && year <= 69)
                year += 2000;
        }
        if (time === null || day === null || month === null || year === null)
            return null;
        if (day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59)
            return null;
        const ms = DateUTC(year, month, day, time[0], time[1], time[2]);
        // A day past the month's end (Feb 30) is refused, as the algorithm says ("the date does not exist").
        if (!NumberIsFinite(ms) || DateGetUTCDate(new HostDate(ms)) !== day)
            return null;
        return ms;
    }

    function parseSetCookie(string, now = DateNow()) {
        string = S(string);
        if (hasControl(string))
            return null;
        let semi = StrIndexOf(string, ';');
        const pair = semi < 0 ? string : StrSlice(string, 0, semi);
        let name, value;
        const eq = StrIndexOf(pair, '=');
        if (eq < 0) {
            name = '';
            value = trimWsp(pair);
        } else {
            name = trimWsp(StrSlice(pair, 0, eq));
            value = trimWsp(StrSlice(pair, eq + 1));
        }
        if (name === '' && value === '')
            return null;
        if (name.length + value.length > MAX_NAME_VALUE)
            return null;
        const out = { __proto__: null, name, value, expires: null, maxAge: null, domain: null, path: null, secure: false, httpOnly: false, sameSite: 'unspecified', partitioned: false };
        let rest = semi < 0 ? '' : StrSlice(string, semi + 1);
        while (rest !== '') {
            semi = StrIndexOf(rest, ';');
            const av = semi < 0 ? rest : StrSlice(rest, 0, semi);
            rest = semi < 0 ? '' : StrSlice(rest, semi + 1);
            const e = StrIndexOf(av, '=');
            const attr = StrToLower(trimWsp(e < 0 ? av : StrSlice(av, 0, e)));
            const val = e < 0 ? '' : trimWsp(StrSlice(av, e + 1));
            if (val.length > MAX_ATTRIBUTE_VALUE)
                continue;
            if (attr === 'expires') {
                const t = parseCookieDate(val);
                if (t !== null)
                    out.expires = t;
            } else if (attr === 'max-age') {
                if (RegExpExec(/^-?\d+$/, val) === null)
                    continue;
                const n = NumberParseInt(val, 10);
                out.maxAge = n <= 0 ? EARLIEST : now + (n * 1000 > MAX_AGE_MS ? MAX_AGE_MS : n * 1000);
            } else if (attr === 'domain') {
                if (val === '')
                    continue;
                let d = StrToLower(val);
                if (StrStartsWith(d, '.'))
                    d = StrSlice(d, 1);
                out.domain = d;
            } else if (attr === 'path') {
                out.path = val !== '' && StrStartsWith(val, '/') ? val : null;
            } else if (attr === 'secure') {
                out.secure = true;
            } else if (attr === 'httponly') {
                out.httpOnly = true;
            } else if (attr === 'samesite') {
                const v = StrToLower(val);
                out.sameSite = v === 'strict' ? 'strict' : v === 'lax' ? 'lax' : v === 'none' ? 'none' : 'unspecified';
            } else if (attr === 'partitioned') {
                out.partitioned = true;
            }
        }
        // Max-Age wins over Expires; both are capped at 400 days from now (6265bis 5.5, 5.6.1).
        let expires = out.maxAge !== null ? out.maxAge : out.expires;
        if (expires !== null && expires !== EARLIEST && expires > now + MAX_AGE_MS)
            expires = now + MAX_AGE_MS;
        out.expires = expires;
        return out;
    }

    // --- Matching ----------------------------------------------------------------------------------------------------------
    function domainMatch(host, domain) {
        if (host === domain)
            return true;
        return !isIp(host) && StrEndsWith(host, '.' + domain);
    }
    // The default-path of a URL path (6265bis 5.1.4).
    function defaultPath(path) {
        if (!StrStartsWith(path, '/'))
            return '/';
        const i = StrLastIndexOf(path, '/');
        return i <= 0 ? '/' : StrSlice(path, 0, i);
    }
    function pathMatch(reqPath, cookiePath) {
        if (reqPath === cookiePath)
            return true;
        if (!StrStartsWith(reqPath, cookiePath))
            return false;
        return StrEndsWith(cookiePath, '/') || StrCharCodeAt(reqPath, cookiePath.length) === 0x2f;
    }
    const lowerStarts = (s, p) => StrStartsWith(StrToLower(s), p);

    function bucketOf(c) {
        return c.partitionKey === '' ? '' : c.partitionKey + (c.partitioned ? '' : '\tu');
    }
    function cookieKey(c) {
        return bucketOf(c) + '\n' + c.name + '\n' + c.domain + '\n' + c.path;
    }

    // A record from another context (a segment's message, the persisted store): every field typed, nothing else kept.
    function checkRecord(r) {
        if (r === null || typeof r !== 'object')
            return null;
        const str = (v, max) => typeof v === 'string' && v.length <= max;
        if (!str(r.name, MAX_NAME_VALUE) || !str(r.value, MAX_NAME_VALUE) || r.name.length + r.value.length > MAX_NAME_VALUE)
            return null;
        if (!str(r.domain, 255) || r.domain === '' || !str(r.path, MAX_ATTRIBUTE_VALUE) || !StrStartsWith(r.path, '/') || !str(r.partitionKey, 600))
            return null;
        if (hasControl(r.name) || hasControl(r.value) || hasControl(r.domain) || hasControl(r.path) || hasControl(r.partitionKey))
            return null;
        if (r.expires !== null && !(typeof r.expires === 'number' && NumberIsFinite(r.expires)))
            return null;
        if (r.sameSite !== 'strict' && r.sameSite !== 'lax' && r.sameSite !== 'none' && r.sameSite !== 'unspecified')
            return null;
        if (typeof r.hostOnly !== 'boolean' || typeof r.secure !== 'boolean' || typeof r.httpOnly !== 'boolean' || typeof r.partitioned !== 'boolean')
            return null;
        if (r.partitionKey === '' && r.partitioned)
            return null;
        const num = (v) => typeof v === 'number' && NumberIsFinite(v) ? v : 0;
        return {
            __proto__: null, name: r.name, value: r.value, domain: r.domain, hostOnly: r.hostOnly, path: r.path, expires: r.expires,
            secure: r.secure, httpOnly: r.httpOnly, sameSite: r.sameSite, partitionKey: r.partitionKey, partitioned: r.partitioned,
            site: registrableDomain(r.domain), created: num(r.created), lastAccess: num(r.lastAccess),
        };
    }
    function plain(c) {
        // A copy with an ordinary prototype, for structured clone (postMessage, IndexedDB).
        return {
            name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, expires: c.expires, secure: c.secure,
            httpOnly: c.httpOnly, sameSite: c.sameSite, partitionKey: c.partitionKey, partitioned: c.partitioned, site: c.site,
            created: c.created, lastAccess: c.lastAccess,
        };
    }

    // --- The store ---------------------------------------------------------------------------------------------------------
    // Records by key; the same class serves the segment's jar and the carapace's store.
    function createStore(now) {
        const all = new HostMap();
        const expired = (c, t) => c.expires !== null && c.expires <= t;
        const store = {
            __proto__: null,
            all,
            get: (key) => MapGet(all, key),
            put(c) { MapSet(all, cookieKey(c), c); },
            remove(key) { return MapDelete(all, key); },
            size: () => MapSize(all),
            each(fn) { MapForEach(all, (c, k) => fn(c, k)); },
            purgeExpired() {
                const t = now();
                const gone = arr();
                MapForEach(all, (c, k) => { if (expired(c, t)) push(gone, k); });
                for (let i = 0; i < gone.length; i++)
                    MapDelete(all, gone[i]);
                return toArray(gone);
            },
            // Chrome's garbage collection (CookieMonster::GarbageCollect, simplified): over 180 cookies of one site in one
            // bucket, the least recently used go, non-secure ones first, until 150 are left; over 10 KiB in one partition of
            // one site, the oldest partitioned ones go; over 3300 in all, the least recently used go until 3000 are left.
            evict(changed) {
                const removed = arr();
                const groups = new HostMap();
                MapForEach(all, (c, k) => {
                    const g = bucketOf(c) + '\n' + c.site;
                    let list = MapGet(groups, g);
                    if (list === undefined)
                        MapSet(groups, g, list = arr());
                    push(list, k);
                });
                const lru = (a, b) => {
                    const ca = MapGet(all, a), cb = MapGet(all, b);
                    if (ca.secure !== cb.secure)
                        return ca.secure ? 1 : -1;
                    return ca.lastAccess - cb.lastAccess;
                };
                MapForEach(groups, (list, g) => {
                    if (changed !== undefined && !MapHas(changed, g))
                        return;
                    if (list.length > DOMAIN_MAX) {
                        ArraySort(list, lru);
                        for (let i = 0; i < DOMAIN_PURGE + list.length - DOMAIN_MAX; i++) {
                            MapDelete(all, list[i]);
                            push(removed, list[i]);
                        }
                    }
                    const first = MapGet(all, list[list.length - 1]);
                    if (first && first.partitioned) {
                        let bytes = 0;
                        const live = arr();
                        for (let i = 0; i < list.length; i++) {
                            const c = MapGet(all, list[i]);
                            if (c) {
                                bytes += c.name.length + c.value.length;
                                push(live, list[i]);
                            }
                        }
                        ArraySort(live, (a, b) => MapGet(all, a).lastAccess - MapGet(all, b).lastAccess);
                        for (let i = 0; bytes > PARTITION_MAX_BYTES && i < live.length; i++) {
                            const c = MapGet(all, live[i]);
                            bytes -= c.name.length + c.value.length;
                            MapDelete(all, live[i]);
                            push(removed, live[i]);
                        }
                    }
                });
                if (MapSize(all) > TOTAL_MAX) {
                    const keys = arr();
                    MapForEach(all, (c, k) => push(keys, k));
                    ArraySort(keys, (a, b) => MapGet(all, a).lastAccess - MapGet(all, b).lastAccess);
                    for (let i = 0; i < TOTAL_PURGE + keys.length - TOTAL_MAX; i++) {
                        MapDelete(all, keys[i]);
                        push(removed, keys[i]);
                    }
                }
                return toArray(removed);
            },
            clear() { MapClear(all); },
        };
        return store;
    }

    // --- The segment's jar -------------------------------------------------------------------------------------------------
    // config: {
    //   site:          the segment's registrable domain (its own jar; every other site's cookies are another segment's)
    //   nested:        a cross-site iframe's segment: its documents' site for cookies is null (6265bis 5.2.1)
    //   topSite:       a nested segment's top-level schemeful site (its partition key), given by the carapace
    //   initiator:     the schemeful site that asked for the first navigation (null: the user, from the address bar)
    //   cookies:       the records the carapace gave this segment
    //   onChange(list) the records this jar changed (deleted ones have `deleted: true`), for the carapace
    //   now()          ms since the epoch
    // }
    // The jar also needs, per segment, the schemeful site of its current top-level document (topDocument), which it learns
    // from the navigations it sends (ctx.kind 'navigate-top') and the host's navigated callback (setTopDocument).
    function createJar(config) {
        config = config || obj();
        const now = typeof config.now === 'function' ? config.now : DateNow;
        let site = typeof config.site === 'string' && config.site !== '' ? StrToLower(config.site) : null;
        const nested = config.nested === true;
        const nestedTop = nested && typeof config.topSite === 'string' ? config.topSite : null;
        let initiator = typeof config.initiator === 'string' ? config.initiator : null;
        let firstNavigation = true;
        let topDocument = null;              // schemeful site of the top-level document of this (top-level) segment
        const onChange = typeof config.onChange === 'function' ? config.onChange : null;
        const store = createStore(now);
        if (config.cookies) {
            const list = config.cookies;
            for (let i = 0; i < list.length; i++) {
                const c = checkRecord(list[i]);
                if (c !== null)
                    store.put(c);
            }
        }
        let pending = null;
        function changed(c, deleted) {
            if (!onChange)
                return;
            const p = plain(c);
            if (deleted)
                p.deleted = true;
            if (pending === null) {
                pending = arr();
                hostQueueMicrotask ? hostQueueMicrotask(flush) : flush();
            }
            push(pending, p);
        }
        function flush() {
            if (pending === null)
                return;
            const list = pending;
            pending = null;
            onChange(toArray(list));
        }

        // The context of a request or a script, as the parts of 6265bis 5.2 need it:
        //   siteForCookies   schemeful site, or null (a cross-site iframe's documents)
        //   partitionKey     '<top schemeful site> <cross-site ancestor bit>'
        //   strict           the request is same-site for Strict (its initiator is same-site too)
        //   topLevel         a top-level navigation (Lax applies to safe methods)
        //   safe             the method is safe (GET, HEAD, OPTIONS, TRACE)
        function contextOf(url, ctx) {
            const kind = ctx && ctx.kind || 'subresource';
            const method = ctx && typeof ctx.method === 'string' ? ctx.method : 'GET';
            const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'TRACE';
            const target = schemefulSite(url);
            let siteForCookies, top, strict = true;
            if (kind === 'navigate-top' && !nested) {
                siteForCookies = target;
                top = target;
                // The first document of a segment was asked for by another site's page or by the user (initiator null): a
                // later one by this segment's own document, which is same-site with it unless the scheme changed.
                const from = firstNavigation ? initiator : topDocument;
                strict = from === null || from === target;
            } else if (nested) {
                siteForCookies = null;
                top = nestedTop;
            } else {
                siteForCookies = topDocument !== null ? topDocument : target;
                top = siteForCookies;
            }
            const sameSite = siteForCookies !== null && siteForCookies === target;
            return {
                __proto__: null, kind, safe, sameSite, strict: sameSite && strict, topLevel: kind === 'navigate-top' && !nested,
                siteForCookies, partitionKey: top === null ? '' : top + (nested ? ' 1' : ' 0'),
            };
        }
        // Which bucket an unpartitioned cookie of `host` lives in for this context.
        function unpartitionedBucket(host, c) {
            if (site === null)
                site = registrableDomain(host);
            return registrableDomain(host) === site ? '' : c.partitionKey + '\tu';
        }

        function sendable(c, u, x, script) {
            if (c.hostOnly ? u.host !== c.domain : !domainMatch(u.host, c.domain))
                return false;
            if (!pathMatch(u.path, c.path))
                return false;
            if (c.secure && !u.secure)
                return false;
            if (c.httpOnly && script)
                return false;
            if (c.sameSite === 'none')
                return true;
            if (!x.sameSite)
                return false;
            if (c.sameSite === 'strict' && !x.strict)
                return false;
            // A cross-site top-level navigation carries Lax cookies with a safe method only; Chrome's "Lax-allowing-unsafe"
            // lets a cookie without SameSite that is under two minutes old ride on an unsafe one too.
            if (!x.strict && x.topLevel && !x.safe)
                return c.sameSite === 'unspecified' && now() - c.created < LAX_ALLOW_UNSAFE_MS;
            return true;
        }
        // The cookies for a request (or document.cookie when `script`), in 6265bis order: longer paths first, then the
        // earlier created.
        function select(url, ctx, script) {
            const u = parseUrl(url);
            if (u === null)
                return arr();
            store.purgeExpired();
            const x = contextOf(url, ctx);
            const own = unpartitionedBucket(u.host, x);
            const list = arr();
            store.each((c) => {
                const b = bucketOf(c);
                if (b !== own && !(c.partitioned && b === x.partitionKey))
                    return;
                if (sendable(c, u, x, script))
                    push(list, c);
            });
            ArraySort(list, (a, b) => (b.path.length - a.path.length) || (a.created - b.created));
            const t = now();
            for (let i = 0; i < list.length; i++)
                list[i].lastAccess = t;
            return list;
        }
        function serialize(list) {
            let out = '';
            for (let i = 0; i < list.length; i++) {
                const c = list[i];
                if (i)
                    out += '; ';
                out += c.name === '' ? c.value : c.name + '=' + c.value;
            }
            return out;
        }

        // The storage model (6265bis 5.7) with Chrome's checks. Returns the stored record, or null when it was refused.
        function storeString(url, string, ctx) {
            const u = parseUrl(url);
            if (u === null)
                return null;
            const script = ctx && ctx.kind === 'script';
            const t = now();
            const p = parseSetCookie(string, t);
            if (p === null)
                return null;
            const x = contextOf(url, ctx);
            if (p.httpOnly && script)
                return null;
            if (p.secure && !u.secure)
                return null;
            // Domain: a public suffix only as the host itself (then host-only), and it must domain-match the host.
            let domain, hostOnly;
            if (p.domain !== null) {
                let d = p.domain;
                if (isPublicSuffix(d)) {
                    if (d !== u.host)
                        return null;
                    d = null;
                }
                if (d !== null && !domainMatch(u.host, d))
                    return null;
                if (d === null || (isIp(u.host) && d === u.host)) {
                    domain = u.host;
                    hostOnly = true;
                } else {
                    domain = d;
                    hostOnly = false;
                }
            } else {
                domain = u.host;
                hostOnly = true;
            }
            const path = p.path !== null ? p.path : defaultPath(u.path);
            // SameSite=None needs Secure (Chrome); Lax, Strict and the default are refused from a cross-site context,
            // except on the response to a top-level navigation (6265bis 5.7, step 15).
            if (p.sameSite === 'none' && !p.secure)
                return null;
            if (p.sameSite !== 'none' && !x.sameSite && !x.topLevel)
                return null;
            // Prefixes, case-insensitively (6265bis 4.1.3); a nameless cookie may not look like one.
            const prefixed = p.name !== '' ? p.name : p.value;
            if (lowerStarts(prefixed, '__secure-') && (!p.secure || !u.secure))
                return null;
            if (lowerStarts(prefixed, '__host-') && (!p.secure || !u.secure || !hostOnly || path !== '/'))
                return null;
            // CHIPS: Partitioned needs Secure; without a partition key (no top-level site) the cookie is unpartitioned.
            if (p.partitioned && !p.secure)
                return null;
            const partitioned = p.partitioned && x.partitionKey !== '';
            const c = {
                __proto__: null, name: p.name, value: p.value, domain, hostOnly, path, expires: p.expires, secure: p.secure,
                httpOnly: p.httpOnly, sameSite: p.sameSite, partitionKey: '', partitioned, site: registrableDomain(domain),
                created: t, lastAccess: t,
            };
            if (partitioned)
                c.partitionKey = x.partitionKey;
            else if (unpartitionedBucket(u.host, x) !== '')
                c.partitionKey = x.partitionKey;
            if (c.partitionKey === '' && unpartitionedBucket(u.host, x) !== '')
                return null; // a foreign site with no partition to keep it in
            const bucket = bucketOf(c);
            // A page's script may not replace an HttpOnly cookie; an insecure URL may not shadow a Secure one ("leave secure
            // cookies alone", 6265bis 5.7 step 16).
            const key = cookieKey(c);
            const old = store.get(key);
            if (old && old.httpOnly && script)
                return null;
            if (!u.secure) {
                let shadow = false;
                store.each((o) => {
                    if (!shadow && o.secure && o.name === c.name && bucketOf(o) === bucket && (domainMatch(o.domain, c.domain) || domainMatch(c.domain, o.domain)) && pathMatch(c.path, o.path))
                        shadow = true;
                });
                if (shadow)
                    return null;
            }
            if (old)
                c.created = old.created;
            if (c.expires !== null && c.expires <= t) {
                if (old) {
                    store.remove(key);
                    changed(old, true);
                }
                return c;
            }
            store.put(c);
            changed(c, false);
            const groups = new HostMap();
            MapSet(groups, bucket + '\n' + c.site, true);
            const removed = store.evict(groups);
            for (let i = 0; i < removed.length; i++)
                changed({ __proto__: null, ...keyParts(removed[i]) }, true);
            return c;
        }
        function keyParts(key) {
            const parts = StrSplit(key, '\n');
            const b = parts[0];
            const tab = StrIndexOf(b, '\t');
            return {
                __proto__: null, name: parts[1], value: '', domain: parts[2], path: parts[3], hostOnly: false, expires: null, secure: false,
                httpOnly: false, sameSite: 'unspecified', partitionKey: tab < 0 ? b : StrSlice(b, 0, tab), partitioned: b !== '' && tab < 0,
                site: registrableDomain(parts[2]), created: 0, lastAccess: 0,
            };
        }

        const jar = {
            __proto__: null,
            // The Cookie header for a request (ctx: { kind: 'navigate-top' | 'navigate-frame' | 'subresource' | 'websocket',
            // method }); '' when no cookie goes.
            header(url, ctx) {
                const out = serialize(select(url, ctx, false));
                // The document a top-level navigation fetches is the site for cookies of what it loads next (its subresources
                // start before the navigation is reported done); each redirect hop moves it.
                if (ctx && ctx.kind === 'navigate-top' && !nested) {
                    const s = schemefulSite(url);
                    if (s !== null)
                        topDocument = s;
                }
                return out;
            },
            // A response's Set-Cookie lines (an array of strings), or one document.cookie write (ctx.kind 'script').
            store(url, lines, ctx) {
                let n = 0;
                if (typeof lines === 'string') {
                    if (storeString(url, lines, ctx) !== null)
                        n++;
                    return n;
                }
                for (let i = 0; i < lines.length; i++)
                    if (storeString(url, lines[i], ctx) !== null)
                        n++;
                return n;
            },
            // document.cookie for a document at `url` (no HttpOnly; the document's own context).
            forScript(url) {
                return serialize(select(url, { __proto__: null, kind: 'script' }, true));
            },
            // The records a script may see (CookieStore): name and value, plus what the Cookie Store API reports.
            listForScript(url) {
                const list = select(url, { __proto__: null, kind: 'script' }, true);
                const out = arr();
                for (let i = 0; i < list.length; i++)
                    out[i] = plain(list[i]);
                return toArray(out);
            },
            setTopDocument(url) {
                const s = schemefulSite(url);
                if (s !== null && !nested) {
                    topDocument = s;
                    firstNavigation = false;
                }
                if (site === null) {
                    const u = parseUrl(url);
                    if (u)
                        site = registrableDomain(u.host);
                }
            },
            // Changes from the carapace (another segment's writes, a clear): records, deleted ones marked.
            apply(list) {
                for (let i = 0; i < list.length; i++) {
                    const r = list[i];
                    const c = checkRecord(r);
                    if (c === null)
                        continue;
                    if (r.deleted === true)
                        store.remove(cookieKey(c));
                    else
                        store.put(c);
                }
            },
            all() {
                const out = arr();
                store.each((c) => { out[out.length] = plain(c); });
                return toArray(out);
            },
            flush,
            contextOf,
            get site() { return site; },
        };
        return jar;
    }

    return ObjectFreeze({
        __proto__: null,
        parseSetCookie, parseCookieDate, registrableDomain, isPublicSuffix, schemefulSite, parseUrl, domainMatch, pathMatch, defaultPath,
        createJar, createStore, bucketOf, cookieKey, checkRecord, plain,
        LIMITS: ObjectFreeze({ __proto__: null, MAX_NAME_VALUE, MAX_ATTRIBUTE_VALUE, MAX_AGE_MS, DOMAIN_MAX, TOTAL_MAX, PARTITION_MAX_BYTES }),
    });
})();

// ===== glue/engine/20-wasi.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the system imports of ganglion.wasm, written by hand in the hardened style of
// glue/00-primordials.js. Emscripten's own JS runtime never runs in the page realm (docs/toolchain.md);
// the module is linked standalone, so its C library asks for WASI functions and a few Emscripten
// library calls, and every one it can get is here. Anything else fails loudly (90-boot.js).
//
// References: WASI preview1 (wasi_snapshot_preview1), Emscripten 4.0.11 system/lib/libc and
// src/library_*.js for the env.* names (docs/phase1.md, "System imports").

const hostCrypto = globalThis.crypto;
const cryptoGetRandomValues = hostCrypto && hostCrypto.getRandomValues ? uncurryThis(hostCrypto.getRandomValues) : undefined;
const Uint8Array_ = globalThis.Uint8Array;
const BigInt64Array_ = globalThis.BigInt64Array;
const DateNow = globalThis.Date.now;
const HostBigInt = globalThis.BigInt;
const TextDecoderUtf8 = new TextDecoder('utf-8');

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_EINVAL = 28;
const WASI_ENOENT = 44;
const WASI_ENOSYS = 52;
const WASI_ENOTSUP = 58;

// Pending stderr/stdout text, flushed to the log at newlines.
let logBuffer = '';

function makeWasiImports(state) {
    // state: { u8(), u32(), f64(), log(text) } where the view getters return fresh views after growth.
    const emit = (bytes) => {
        logBuffer += TextDecoderPrototypeDecode(TextDecoderUtf8, bytes, { __proto__: null, stream: true });
        let nl;
        while ((nl = logBuffer.indexOf('\n')) >= 0) {
            state.log(logBuffer.slice(0, nl));
            logBuffer = logBuffer.slice(nl + 1);
        }
    };
    const wasi = { __proto__: null };
    wasi.fd_write = (fd, iovs, iovsLen, nwritten) => {
        const u8 = state.u8();
        const u32 = state.u32();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
            const ptr = u32[(iovs >>> 2) + i * 2];
            const len = u32[(iovs >>> 2) + i * 2 + 1];
            if (fd === 1 || fd === 2) {
                // A copy: the decoder must never see a view it could keep.
                const chunk = new Uint8Array_(len);
                for (let j = 0; j < len; j++)
                    chunk[j] = u8[ptr + j];
                emit(chunk);
            }
            total += len;
        }
        u32[nwritten >>> 2] = total;
        return fd === 1 || fd === 2 ? WASI_ESUCCESS : WASI_EBADF;
    };
    wasi.fd_read = (fd, iovs, iovsLen, nread) => {
        state.u32()[nread >>> 2] = 0;
        return fd === 0 ? WASI_ESUCCESS : WASI_EBADF;
    };
    wasi.fd_close = () => WASI_EBADF;
    wasi.fd_seek = (fd, offset, whence, newOffset) => WASI_EBADF;
    wasi.fd_sync = () => WASI_ESUCCESS;
    wasi.fd_fdstat_get = (fd, out) => {
        if (fd > 2)
            return WASI_EBADF;
        const u8 = state.u8();
        for (let i = 0; i < 24; i++)
            u8[out + i] = 0;
        u8[out] = 2; // character device
        return WASI_ESUCCESS;
    };
    wasi.fd_fdstat_set_flags = () => WASI_ENOSYS;
    wasi.fd_prestat_get = () => WASI_EBADF;
    wasi.fd_prestat_dir_name = () => WASI_EBADF;
    wasi.fd_filestat_get = () => WASI_EBADF;
    wasi.fd_readdir = () => WASI_EBADF;
    wasi.path_open = () => WASI_ENOENT;
    wasi.path_filestat_get = () => WASI_ENOENT;
    wasi.path_unlink_file = () => WASI_ENOENT;
    wasi.path_remove_directory = () => WASI_ENOENT;
    wasi.path_create_directory = () => WASI_ENOTSUP;
    wasi.path_readlink = () => WASI_ENOENT;
    wasi.path_rename = () => WASI_ENOENT;
    wasi.path_symlink = () => WASI_ENOTSUP;
    wasi.fd_pread = () => WASI_EBADF;
    wasi.fd_pwrite = () => WASI_EBADF;
    wasi.environ_sizes_get = (count, size) => {
        const u32 = state.u32();
        u32[count >>> 2] = 0;
        u32[size >>> 2] = 0;
        return WASI_ESUCCESS;
    };
    wasi.environ_get = () => WASI_ESUCCESS;
    wasi.args_sizes_get = (count, size) => {
        const u32 = state.u32();
        u32[count >>> 2] = 0;
        u32[size >>> 2] = 0;
        return WASI_ESUCCESS;
    };
    wasi.args_get = () => WASI_ESUCCESS;
    wasi.clock_res_get = (id, out) => {
        const u32 = state.u32();
        u32[out >>> 2] = 1000;
        u32[(out >>> 2) + 1] = 0;
        return WASI_ESUCCESS;
    };
    // i64 parameters arrive as BigInts (Emscripten links with WASM_BIGINT): (id, precision, out).
    wasi.clock_time_get = (id, precision, out) => {
        // 0 realtime, 1 monotonic (and the process/thread clocks count as monotonic here), in nanoseconds.
        let ns;
        if (id === 0)
            ns = HostBigInt(DateNow()) * 1000000n;
        else
            ns = HostBigInt(MathFloor(hostPerformanceNow(hostPerformance) * 1000)) * 1000n;
        // Two 32-bit stores: the out pointer need not be 8-byte aligned (Emscripten's clock_gettime passes a
        // 4-aligned stack slot), and a BigInt64Array index would floor it.
        const u32 = state.u32();
        u32[out >>> 2] = HostNumber(ns & 0xffffffffn);
        u32[(out >>> 2) + 1] = HostNumber(ns >> 32n);
        return WASI_ESUCCESS;
    };
    wasi.random_get = (ptr, len) => {
        const u8 = state.u8();
        if (!cryptoGetRandomValues)
            return WASI_ENOSYS;
        let done = 0;
        while (done < len) {
            const n = MathMin(65536, len - done);
            const chunk = new Uint8Array_(n);
            cryptoGetRandomValues(hostCrypto, chunk);
            for (let i = 0; i < n; i++)
                u8[ptr + done + i] = chunk[i];
            done += n;
        }
        return WASI_ESUCCESS;
    };
    wasi.proc_exit = (code) => {
        throw new HostError('ganglion: proc_exit(' + code + ')');
    };
    wasi.sched_yield = () => WASI_ESUCCESS;
    wasi.poll_oneoff = () => WASI_ENOSYS;
    return wasi;
}

// The Emscripten library functions the standalone module still imports from "env". Each one is here
// because the link listed it; an import without an entry fails at instantiation (90-boot.js).
function makeEnvImports(state) {
    const env = { __proto__: null };
    env.emscripten_notify_memory_growth = () => state.refreshViews();
    env.emscripten_date_now = () => DateNow();
    env.emscripten_get_now = () => hostPerformanceNow(hostPerformance);
    env._emscripten_get_now_is_monotonic = () => 1;
    env._abort_js = () => {
        throw new HostError('ganglion: abort()');
    };
    env.__assert_fail = (condition, file, line, func) => {
        throw new HostError('ganglion: assertion failed: ' + state.cString(condition) + ' at ' + state.cString(file) + ':' + line);
    };
    // setjmp/longjmp, Emscripten style: a function that calls setjmp calls its callees through invoke_<sig>,
    // which catches the longjmp (thrown here as a number, which nothing else throws) and tells the wasm side
    // with setThrew. FreeType, libpng and libjpeg use setjmp for their error paths.
    env._emscripten_throw_longjmp = () => {
        throw Infinity;
    };
    env.__syscall_getcwd = (buf, size) => {
        const u8 = state.u8();
        if (size < 2)
            return -34; // ERANGE
        u8[buf] = 47; // "/"
        u8[buf + 1] = 0;
        return 2;
    };
    env.__syscall_ioctl = () => -25; // ENOTTY
    env.__syscall_fcntl64 = () => -9; // EBADF
    env.__syscall_openat = () => -2; // ENOENT
    env.__syscall_stat64 = () => -2;
    env.__syscall_lstat64 = () => -2;
    env.__syscall_fstat64 = () => -9;
    env.__syscall_newfstatat = () => -2;
    env.__syscall_readlinkat = () => -2;
    env.__syscall_mkdirat = () => -38;
    env.__syscall_unlinkat = () => -2;
    env.__syscall_rmdir = () => -2;
    env.__syscall_renameat = () => -2;
    env.__syscall_faccessat = () => -2;
    env.__syscall_getdents64 = () => -9;
    env.__syscall_pipe = () => -38; // ENOSYS
    env.__syscall_poll = () => -38;
    env.__syscall_dup3 = () => -38;
    env.__syscall_socket = () => -38;
    env.__syscall_connect = () => -38;
    env.__syscall_bind = () => -38;
    env.__syscall_listen = () => -38;
    env.__syscall_accept4 = () => -38;
    env.__syscall_sendto = () => -38;
    env.__syscall_recvfrom = () => -38;
    env.__syscall_getsockopt = () => -38;
    env.__syscall_setsockopt = () => -38;
    env.__syscall_getsockname = () => -38;
    env.__syscall_getpeername = () => -38;
    env.__syscall_shutdown = () => -38;
    env._mmap_js = () => -38;
    env._munmap_js = () => -38;
    env._msync_js = () => -38;
    env._tzset_js = (timezone, daylight, stdName, dstName) => {
        const u32 = state.u32();
        const u8 = state.u8();
        u32[timezone >>> 2] = 0;
        u32[daylight >>> 2] = 0;
        u8[stdName] = 85; // "UTC"
        u8[stdName + 1] = 84;
        u8[stdName + 2] = 67;
        u8[stdName + 3] = 0;
        u8[dstName] = 85;
        u8[dstName + 1] = 84;
        u8[dstName + 2] = 67;
        u8[dstName + 3] = 0;
    };
    const writeTm = (tm, t, utc) => {
        const d = new (globalThis.Date)(t * 1000);
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        i32[base] = utc ? d.getUTCSeconds() : d.getSeconds();
        i32[base + 1] = utc ? d.getUTCMinutes() : d.getMinutes();
        i32[base + 2] = utc ? d.getUTCHours() : d.getHours();
        i32[base + 3] = utc ? d.getUTCDate() : d.getDate();
        i32[base + 4] = utc ? d.getUTCMonth() : d.getMonth();
        i32[base + 5] = (utc ? d.getUTCFullYear() : d.getFullYear()) - 1900;
        i32[base + 6] = utc ? d.getUTCDay() : d.getDay();
        const start = new (globalThis.Date)(d.getFullYear(), 0, 1);
        i32[base + 7] = MathFloor((d - start) / 86400000);
        i32[base + 8] = 0;
        i32[base + 9] = utc ? 0 : -d.getTimezoneOffset() * 60;
    };
    env._localtime_js = (t, tm) => writeTm(tm, HostNumber(t), false);
    env._gmtime_js = (t, tm) => writeTm(tm, HostNumber(t), true);
    env._mktime_js = (tm) => {
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        const d = new (globalThis.Date)(i32[base + 5] + 1900, i32[base + 4], i32[base + 3], i32[base + 2], i32[base + 1], i32[base]);
        return HostBigInt(MathFloor(d.getTime() / 1000));
    };
    env._timegm_js = (tm) => {
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        return HostBigInt(MathFloor(globalThis.Date.UTC(i32[base + 5] + 1900, i32[base + 4], i32[base + 3], i32[base + 2], i32[base + 1], i32[base]) / 1000));
    };
    env._setitimer_js = () => 0;
    env.emscripten_get_heap_max = () => 2147483648;
    env.emscripten_resize_heap = (requested) => {
        // Growth is driven by the module itself in standalone mode through memory.grow; a request here means
        // sbrk could not grow: let it, in 64 KiB pages.
        const memory = state.memory();
        const current = WebAssemblyMemoryPrototypeGetBuffer(memory).byteLength;
        const pages = MathFloor((requested - current + 65535) / 65536);
        try {
            memory.grow(pages);
            state.refreshViews();
            return 1;
        } catch {
            return 0;
        }
    };
    env.emscripten_console_error = (ptr) => state.log(state.cString(ptr));
    env.emscripten_err = (ptr) => state.log(state.cString(ptr));
    env.emscripten_out = (ptr) => state.log(state.cString(ptr));
    env._emscripten_system = () => -38;
    env._emscripten_runtime_keepalive_clear = () => {};
    env.emscripten_force_exit = (code) => {
        throw new HostError('ganglion: exit(' + code + ')');
    };
    env.exit = env.emscripten_force_exit;
    env._exit = env.emscripten_force_exit;
    env.pthread_setname_np = () => 0;
    env.pthread_getname_np = () => 0;
    env.__syscall_ftruncate64 = () => -9;
    env.__syscall_recvmsg = () => -38;
    env.__syscall_sendmsg = () => -38;
    env.getentropy = (ptr, len) => {
        const u8 = state.u8();
        if (!cryptoGetRandomValues)
            return -1;
        const chunk = new Uint8Array_(len);
        cryptoGetRandomValues(hostCrypto, chunk);
        for (let i = 0; i < len; i++)
            u8[ptr + i] = chunk[i];
        return 0;
    };
    return env;
}

// ===== glue/engine/30-host.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the host side of ganglion.wasm. Holds the instance and its memory privately,
// answers the engine's requests (fetch, image decoding, navigation, title, frame requests) through the
// callbacks the segment host passed to boot(), and offers the segment host the engine's entry points.
// Nothing here is reachable from page JS: the host keeps the returned object in its closure.

const Uint8ClampedArray_ = globalThis.Uint8ClampedArray;
const HostImageData = globalThis.ImageData;
const HostPromise = globalThis.Promise;
const PromisePrototypeThen = uncurryThis(HostPromise.prototype.then);
const ArrayPrototypeShift = uncurryThis(globalThis.Array.prototype.shift);
const TypedArrayPrototypeSet = uncurryThis(Uint8ClampedArray_.prototype.set);
const TypedArrayPrototypeSubarray = uncurryThis(globalThis.Uint8Array.prototype.subarray);

let X;            // the engine's exports
let memory;
let u8, u32, f64; // views over linear memory, refreshed after growth
let viewBuffer;
let callbacks;    // the segment host's callbacks
let instance;
const pendingFetches = { __proto__: null };
let pendingHostFetches = 0; // answered by the host but not yet handed to the engine count as pending
const pendingImages = { __proto__: null };
let engineLog = (text) => { if (hostConsoleError) hostConsoleError(hostConsole, text); };
let lastFatalLog = null; // the VERIFICATION FAILED / FATAL line before a trap, if the engine printed one

function refreshEngineViews() {
    const buffer = WebAssemblyMemoryPrototypeGetBuffer(memory);
    if (buffer === viewBuffer)
        return;
    viewBuffer = buffer;
    u8 = new (globalThis.Uint8Array)(buffer);
    u32 = new Uint32Array(buffer);
    f64 = new Float64Array(buffer);
}

function views() {
    refreshEngineViews();
}

// A C string out of linear memory, by indexing only (a copy, decoded with a captured TextDecoder).
function cString(ptr) {
    views();
    let end = ptr;
    while (u8[end] !== 0)
        end++;
    return bytesToString(ptr, end - ptr);
}

const decoderUtf8 = new TextDecoder('utf-8');
const Uint8ArraySlice = uncurryThis(globalThis.Uint8Array.prototype.slice);
function bytesToString(ptr, len) {
    views();
    const copy = new (globalThis.Uint8Array)(len);
    for (let i = 0; i < len; i++)
        copy[i] = u8[ptr + i];
    return TextDecoderPrototypeDecode(decoderUtf8, copy);
}

function utf16ToString(ptr, len) {
    views();
    let s = '';
    const base = ptr >>> 1;
    const u16 = new Uint16Array(viewBuffer);
    for (let i = 0; i < len; i++)
        s += StringFromCharCode(u16[base + i]);
    return s;
}

// Copies bytes into engine memory the engine owns (ganglion_alloc); the caller frees them after the call.
function copyIn(bytes) {
    const len = bytes.length;
    const ptr = X.ganglion_alloc(len + 1);
    views();
    for (let i = 0; i < len; i++)
        u8[ptr + i] = bytes[i];
    u8[ptr + len] = 0;
    return ptr;
}

const encoderUtf8 = new (globalThis.TextEncoder)();
const TextEncoderPrototypeEncode = uncurryThis(globalThis.TextEncoder.prototype.encode);
function copyInString(s) {
    return copyIn(TextEncoderPrototypeEncode(encoderUtf8, s));
}

function engineState() {
    return {
        __proto__: null,
        u8: () => (views(), u8),
        u32: () => (views(), u32),
        f64: () => (views(), f64),
        buffer: () => (views(), viewBuffer),
        memory: () => memory,
        refreshViews: refreshEngineViews,
        log: (text) => engineLog(text),
        cString,
    };
}

// --- The imports the engine asks the host for ------------------------------------------------------

// One task, then the microtasks (docs/crypto.md). The engine's event loop runs a task and then its microtask checkpoint, but
// page JavaScript is the host's V8 and its promise jobs and queueMicrotask callbacks run only when the host's stack unwinds.
// So once page code has run (a call, a construct, a script, a property access that can reach page code, a promise settled
// by the engine) the engine runs nothing more (ganglion_host_turn_pending) until a host task of ours, which runs after the
// host's microtasks: it clears the mark and pumps again. Before, one pump ran several tasks (two timers, a timer and a
// message, a crypto result) and all their microtasks came after the last of them.
let hostJsTouched = 0;
let hostTurnPosted = false;
let hostTurnPort = null;
function hostTurn() {
    hostTurnPosted = false;
    hostJsTouched = 0;
    if (stoppedReason !== null)
        return;
    try {
        if (callbacks.afterEngineCall)
            callbacks.afterEngineCall();
        else
            api.pump();
    } catch (e) {
        // The engine stopped in this turn: options.stopped has said why, once; the refusal that unwound the turn is not a
        // second error.
        if (stoppedReason === null)
            throw e;
    }
}
function postHostTurn() {
    if (hostTurnPosted)
        return;
    hostTurnPosted = true;
    if (hostTurnPort === null && HostMessageChannel !== null) {
        const channel = new HostMessageChannel();
        const receiver = MessageChannelPort2(channel);
        MessagePortSetOnmessage(receiver, hostTurn);
        hostTurnPort = MessageChannelPort1(channel);
        // Node: an idle channel must not keep the process alive.
        if (typeof receiver.unref === 'function')
            receiver.unref();
        if (typeof hostTurnPort.unref === 'function')
            hostTurnPort.unref();
    }
    if (hostTurnPort !== null)
        MessagePortPostMessage(hostTurnPort, 0);
    else
        hostSetTimeout(hostTurn, 0);
}
function makeHostImports() {
    const env = { __proto__: null };
    env.ganglion_host_turn_pending = () => {
        if (hostJsTouched === 0)
            return 0;
        postHostTurn();
        return 1;
    };
    env.ganglion_host_log = (ptr, len) => {
        const text = bytesToString(ptr, len);
        // The engine's last words before a trap (AK's VERIFY and FATAL print, then hit unreachable).
        if (StringPrototypeIncludes(text, 'VERIFICATION FAILED') || StringPrototypeIncludes(text, 'FATAL'))
            lastFatalLog = text;
        engineLog(text);
    };
    // The host may answer a fetch itself (a promise of { status, headers, body }: the harness's stand-in for
    // the test sites, or a page service worker's response) or decline with null, and then the engine fetches over its own
    // network (TCP below). A promise that resolves to null hands the fetch back to the engine's network then (a page service
    // worker that did not call respondWith). The second argument is the rest of the request (describeRequest).
    env.ganglion_host_fetch = (id, urlPtr, urlLen, requestPtr, requestLen, bodyPtr, bodyLen) => {
        const url = bytesToString(urlPtr, urlLen);
        let promise;
        try {
            promise = callbacks.fetch ? callbacks.fetch(url, describeRequest(requestPtr, requestLen, bodyPtr, bodyLen)) : null;
        } catch (e) {
            pendingFetches[id] = url;
            scheduleFetchFailure(id, String(e));
            return 1;
        }
        if (promise === null || promise === undefined)
            return 0;
        pendingFetches[id] = url;
        pendingHostFetches++;
        // The host's fetch runs outside the engine; its result comes back through fetchDone() in a later task.
        PromisePrototypeThen(promise,
            (result) => {
                if (pendingFetches[id] === undefined)
                    return;
                if (result === null || result === undefined)
                    api.fetchNetwork(id);
                else if (typeof result.read === 'function')
                    api.fetchStreamed(id, result.status, result.headers, result.read);
                else
                    api.fetchDone(id, result.status, result.headers, result.body);
            },
            (error) => { if (pendingFetches[id] !== undefined) api.fetchFailed(id, String(error && error.message || error)); });
        return 1;
    };
    env.ganglion_host_net_done = (id, status, headersPtr, headersLen, bodyPtr, bodyLen, errorPtr, errorLen) => {
        const waiter = pendingNetRequests[id];
        if (waiter === undefined)
            return;
        delete pendingNetRequests[id];
        if (errorLen) {
            waiter.reject(bytesToString(errorPtr, errorLen));
            return;
        }
        const body = new (globalThis.Uint8Array)(bodyLen);
        views();
        for (let i = 0; i < bodyLen; i++)
            body[i] = u8[bodyPtr + i];
        waiter.resolve({ __proto__: null, status, headers: headerLines(headersLen ? bytesToString(headersPtr, headersLen) : ''), body });
    };
    // Tunnels (api.tunnelOpen): the host's handlers run in a task of their own, in order, never inside the engine's call.
    env.ganglion_host_tunnel_open = (id, status, reasonPtr, reasonLen, headersPtr, headersLen) => {
        const reason = bytesToString(reasonPtr, reasonLen);
        const headers = headerLines(headersLen ? bytesToString(headersPtr, headersLen) : '');
        tunnelEvent(id, 'onOpen', status, reason, headers);
    };
    env.ganglion_host_tunnel_data = (id, ptr, len) => {
        tunnelEvent(id, 'onData', copyOutBytes(ptr, len));
    };
    env.ganglion_host_tunnel_close = (id, errPtr, errLen) => {
        tunnelEvent(id, 'onClose', errLen ? bytesToString(errPtr, errLen) : '');
    };
    // TCP streams for the engine's own network: the host (Spiracle through the segment) opens them and
    // reports back through tcpOpened / tcpData / tcpClosed. `callbacks.net` is { connect, write, close }.
    env.ganglion_host_tcp_connect = (id, hostPtr, hostLen, port) => {
        const host = bytesToString(hostPtr, hostLen);
        if (!callbacks.net) {
            hostSetTimeout(() => api.tcpClosed(id, 3), 0);
            return;
        }
        callbacks.net.connect(id, host, port);
    };
    // A synchronous stream (Network.cpp: opened inside a nested wait, a synchronous XMLHttpRequest). Its events come back
    // through callbacks.net.waitSync while the engine's thread is blocked; a host without that opens it as an ordinary one
    // (and the wait ends only by the engine's timeouts, as before).
    env.ganglion_host_tcp_connect_sync = (id, hostPtr, hostLen, port) => {
        const host = bytesToString(hostPtr, hostLen);
        if (!callbacks.net) {
            hostSetTimeout(() => api.tcpClosed(id, 3), 0);
            return;
        }
        if (typeof callbacks.net.connectSync === 'function')
            callbacks.net.connectSync(id, host, port);
        else
            callbacks.net.connect(id, host, port);
    };
    // The nested wait (EventLoop.cpp): blocks for at most `ms` (-1: no timer armed) until a synchronous stream has events,
    // delivers them into the engine here, inside the call, and returns how many.
    env.ganglion_host_wait = (ms) => {
        if (!callbacks.net || typeof callbacks.net.waitSync !== 'function')
            return 0;
        const events = callbacks.net.waitSync(ms);
        if (!events)
            return 0;
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.t === 'open')
                X.ganglion_tcp_opened(e.s);
            else if (e.t === 'data') {
                const ptr = copyIn(e.b);
                try {
                    X.ganglion_tcp_data(e.s, ptr, e.b.length);
                } finally {
                    X.ganglion_free(ptr);
                }
            } else if (e.t === 'close')
                X.ganglion_tcp_closed(e.s, e.code | 0);
        }
        return events.length;
    };
    env.ganglion_host_tcp_write = (id, ptr, len) => {
        if (!callbacks.net)
            return;
        callbacks.net.write(id, copyOutBytes(ptr, len));
    };
    env.ganglion_host_tcp_close = (id) => {
        if (callbacks.net)
            callbacks.net.close(id);
    };
    env.ganglion_host_isolation = (isolated) => {
        setPageIsolation(isolated !== 0);
    };
    env.ganglion_host_navigated = (urlPtr, urlLen, status, errPtr, errLen) => {
        if (!errLen)
            cookieJarOf().setTopDocument(bytesToString(urlPtr, urlLen));
        if (callbacks.navigated)
            callbacks.navigated(bytesToString(urlPtr, urlLen), status, errLen ? bytesToString(errPtr, errLen) : null);
    };
    env.ganglion_host_decode_image = (id, ptr, len) => {
        views();
        const copy = new (globalThis.Uint8Array)(len);
        for (let i = 0; i < len; i++)
            copy[i] = u8[ptr + i];
        pendingImages[id] = true;
        let promise;
        try {
            promise = callbacks.decodeImage(copy);
        } catch (e) {
            scheduleImageFailure(id);
            return;
        }
        PromisePrototypeThen(promise,
            (image) => { if (pendingImages[id]) api.imageDone(id, image); },
            () => { if (pendingImages[id]) api.imageFailed(id); });
    };
    // A fallback font subset the engine needs (engine/platform/Fonts.cpp), asked for once: the host's loader answers
    // its bytes (from its cache or the carapace origin); the engine lays the text out again when they arrive.
    env.ganglion_host_load_fallback_font = (id, ptr, len) => {
        const file = bytesToString(ptr, len);
        const loader = fallbackFontLoader;
        if (!loader)
            return;
        hostSetTimeout(() => {
            let promise;
            try {
                promise = loader(file);
            } catch (e) {
                return;
            }
            PromisePrototypeThen(promise, (bytes) => { if (bytes) api.addFallbackFont(id, bytes); }, () => {});
        }, 0);
    };
    env.ganglion_host_navigate = (ptr, len) => {
        const url = bytesToString(ptr, len);
        if (callbacks.navigate)
            callbacks.navigate(url);
    };
    // A classic script just ran (Host.cpp, patch 0023): its microtasks run on the host's queue after the stack unwinds, and
    // document.currentScript stays that script until then. The host says when: a task of its own runs after the microtasks.
    env.ganglion_host_microtask_turn_end_request = () => {
        if (callbacks.afterMicrotasks)
            callbacks.afterMicrotasks(() => api.microtaskTurnEnd());
    };
    // Fullscreen, pointer lock and gamepad effects (Host.cpp; docs/webrtc.md): the carapace owns the host's and answers.
    env.ganglion_host_fullscreen = (enter) => {
        if (callbacks.fullscreen)
            callbacks.fullscreen(enter !== 0);
        else
            HostQueueMicrotask(() => api.fullscreenChanged(false)); // no host: refused, as a window that cannot go fullscreen
    };
    env.ganglion_host_pointer_lock = (kind) => {
        if (callbacks.pointerLock)
            callbacks.pointerLock(kind);
        else if (kind !== 0)
            HostQueueMicrotask(() => api.pointerLockResult(0, 1));
    };
    env.ganglion_host_gamepad_effect = (handle, kind, strong, weak, duration) => {
        if (callbacks.gamepadEffect)
            callbacks.gamepadEffect(handle >>> 0, kind, strong & 0xffff, weak & 0xffff, duration >>> 0);
    };
    env.ganglion_host_title = (ptr, len) => {
        if (callbacks.title)
            callbacks.title(utf16ToString(ptr, len));
    };
    // localStorage (Host.cpp): changed since the host last took it; and the data the host asked for. The host persists
    // it (the Worker: its IndexedDB, before the segment can be replaced by the next document).
    env.ganglion_host_storage_changed = () => {
        if (callbacks.storageChanged)
            callbacks.storageChanged();
    };
    env.ganglion_host_storage_data = (ptr, len) => {
        const text = utf16ToString(ptr, len);
        const entries = [];
        for (let at = 0; at + 4 <= text.length;) {
            const keyLength = text.charCodeAt(at) | (text.charCodeAt(at + 1) << 16);
            const valueLength = text.charCodeAt(at + 2) | (text.charCodeAt(at + 3) << 16);
            at += 4;
            entries[entries.length] = [text.slice(at, at + keyLength), text.slice(at + keyLength, at + keyLength + valueLength)];
            at += keyLength + valueLength;
        }
        if (callbacks.storage)
            callbacks.storage(entries);
    };
    // Whether a frame at `url` in the document at `documentUrl` is on another site: such a frame is a nested segment of
    // the carapace's (glue/engine/50-frames.js lists it), so the engine does not load it. The same rule as the listing.
    env.ganglion_host_frame_is_remote = (urlPtr, urlLen, documentPtr, documentLen) => {
        const site = urlSite(bytesToString(urlPtr, urlLen));
        const own = urlSite(bytesToString(documentPtr, documentLen));
        return site !== null && own !== null && site !== own ? 1 : 0;
    };
    // Cookies (docs/cookies.md): the Cookie header of a request the engine sends, or document.cookie (context "script"); and
    // a response's Set-Cookie lines or one document.cookie write. The jar is glue/cookies.js (cookieJarOf).
    env.ganglion_host_cookie_get = (urlPtr, urlLen, ctxPtr, ctxLen, outPtr) => {
        const url = bytesToString(urlPtr, urlLen);
        const ctx = cookieContext(bytesToString(ctxPtr, ctxLen));
        let text;
        try {
            if (ctx.kind === 'cookiestore') {
                // The Cookie Store API (Host.cpp): name and value of each cookie document.cookie would see, NUL-separated.
                const list = cookieJarOf().listForScript(url);
                text = '';
                for (let i = 0; i < list.length; i++)
                    text += (i ? '\0' : '') + list[i].name + '\0' + list[i].value;
                if (list.length === 0)
                    return 0;
            } else {
                text = ctx.kind === 'script' ? cookieJarOf().forScript(url) : cookieJarOf().header(url, ctx);
            }
        } catch (e) {
            engineLog('cookies: ' + HostString(e && e.message || e));
            text = '';
        }
        if (text === '')
            return 0;
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, text);
        const len = TypedArrayLength(bytes);
        const ptr = X.ganglion_alloc(len + 1);
        views();
        for (let i = 0; i < len; i++)
            u8[ptr + i] = bytes[i];
        u8[ptr + len] = 0;
        u32[outPtr >>> 2] = ptr;
        return len;
    };
    env.ganglion_host_cookie_set = (urlPtr, urlLen, ctxPtr, ctxLen, linesPtr, linesLen) => {
        const url = bytesToString(urlPtr, urlLen);
        const ctx = cookieContext(bytesToString(ctxPtr, ctxLen));
        const text = bytesToString(linesPtr, linesLen);
        try {
            cookieJarOf().store(url, ctx.kind === 'script' ? text : CookieStringSplit(text, '\n'), ctx);
        } catch (e) {
            engineLog('cookies: ' + HostString(e && e.message || e));
        }
    };
    env.ganglion_host_idb_persist = (ptr, len) => {
        if (!callbacks.idbPersist)
            return;
        views();
        const entry = Uint8ArraySlice(u8, ptr, ptr + len);
        try {
            callbacks.idbPersist(entry);
        } catch (e) {
            engineLog('IndexedDB persistence: ' + HostString(e && e.message || e));
        }
    };
    env.ganglion_host_request_frame = () => {
        if (callbacks.requestFrame)
            callbacks.requestFrame();
    };
    addMediaImports(env);
    addWebGLImports(env);
    return env;
}

// --- Cookies (docs/cookies.md) ---------------------------------------------------------------------------------------------
// The segment's jar (glue/cookies.js): made on first use from options.cookies (the carapace's records and the segment's place:
// its site, nested or not, the top-level site of a nested segment, the initiator of its first navigation). Node tests that
// give none get a jar of the first document's site.
let cookieJar = null;
const TypedArrayLength = uncurryThis(ObjectGetOwnPropertyDescriptor(ObjectGetPrototypeOf(globalThis.Uint8Array.prototype), 'length').get);
const CookieStringSplit = uncurryThis(HostString.prototype.split);
function cookieJarOf() {
    if (cookieJar === null)
        cookieJar = ChitinCookies.createJar(callbacks && callbacks.cookies ? callbacks.cookies : null);
    return cookieJar;
}
// "kind\nmethod" (Network.h cookie_header) or "script".
function cookieContext(text) {
    const nl = StringPrototypeIndexOf(text, '\n');
    return { __proto__: null, kind: nl < 0 ? text : StringPrototypeSlice(text, 0, nl), method: nl < 0 ? 'GET' : StringPrototypeSlice(text, nl + 1) };
}

// "name: value" lines into [[name, value], ...] (repeated names stay apart: Set-Cookie).
function headerLines(text) {
    const out = [];
    let at = 0;
    while (at < text.length) {
        let end = StringPrototypeIndexOf(text, '\n', at);
        if (end < 0)
            end = text.length;
        const line = StringPrototypeSlice(text, at, end);
        at = end + 1;
        const colon = StringPrototypeIndexOf(line, ':');
        if (colon > 0)
            out[out.length] = [StringPrototypeTrim(StringPrototypeSlice(line, 0, colon)), StringPrototypeTrim(StringPrototypeSlice(line, colon + 1))];
    }
    return out;
}

// The request behind a ganglion_host_fetch (Host.cpp): method, mode, destination, credentials, navigation, the client's
// document URL, headers, body.
function describeRequest(ptr, len, bodyPtr, bodyLen) {
    const text = len ? bytesToString(ptr, len) : 'GET\nno-cors\n\nomit\n-\n\n';
    const lines = [];
    let at = 0;
    for (let i = 0; i < 6; i++) {
        let end = StringPrototypeIndexOf(text, '\n', at);
        if (end < 0)
            end = text.length;
        lines[i] = StringPrototypeSlice(text, at, end);
        at = end + 1;
    }
    const body = new (globalThis.Uint8Array)(bodyLen);
    if (bodyLen) {
        views();
        for (let i = 0; i < bodyLen; i++)
            body[i] = u8[bodyPtr + i];
    }
    return { __proto__: null, method: lines[0], mode: lines[1], destination: lines[2], credentials: lines[3], navigate: lines[4] === 'navigate', client: lines[5], headers: headerLines(StringPrototypeSlice(text, at)), body };
}

const pendingNetRequests = { __proto__: null };
let nextNetRequest = 1;

const hostSetTimeout = globalThis.setTimeout;
const tunnels = { __proto__: null };
let nextTunnel = 1;
const tunnelQueue = [];
function tunnelEvent(id, name, a, b, c) {
    tunnelQueue[tunnelQueue.length] = [id, name, a, b, c];
    if (tunnelQueue.length === 1)
        hostSetTimeout(drainTunnelEvents, 0);
}
function drainTunnelEvents() {
    // One event at a time, the handlers' own throws contained: a page's handler failing must not strand the rest.
    while (tunnelQueue.length) {
        const [id, name, a, b, c] = ArrayPrototypeShift(tunnelQueue);
        const t = tunnels[id];
        if (t === undefined)
            continue;
        if (name === 'onClose')
            delete tunnels[id];
        try { t[name](a, b, c); } catch (e) { engineLog('tunnel handler ' + name + ': ' + (e && e.stack || e)); }
    }
}
function scheduleFetchFailure(id, message) {
    hostSetTimeout(() => api.fetchFailed(id, message), 0);
}
function scheduleImageFailure(id) {
    hostSetTimeout(() => api.imageFailed(id), 0);
}

// --- The API the segment host gets ------------------------------------------------------------------

const api = { __proto__: null };
// The jar for the host's own requests (WebSocket handshakes, a page worker's fetch) and the carapace's changes (docs/cookies.md).
api.cookies = ObjectFreeze({
    __proto__: null,
    header: (url, ctx) => cookieJarOf().header(url, ctx),
    store: (url, lines, ctx) => cookieJarOf().store(url, lines, ctx),
    forScript: (url) => cookieJarOf().forScript(url),
    listForScript: (url) => cookieJarOf().listForScript(url),
    apply: (list) => cookieJarOf().apply(list),
    all: () => cookieJarOf().all(),
    flush: () => cookieJarOf().flush(),
});

// ICU's common data, before start(); the engine keeps its own copy.
api.setIcuData = (bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_set_icu_data(ptr, bytes.length);
    X.ganglion_free(ptr);
};

api.addFont = (bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_add_font(ptr, bytes.length);
    X.ganglion_free(ptr);
};

// The fallback fonts (docs/fonts.md): the manifest's bytes, the host's languages (navigator.languages) and a loader,
// file name -> Promise<Uint8Array>, for the subsets. Before start().
let fallbackFontLoader = null;
api.setFallbackFonts = (manifest, languages, loader) => {
    fallbackFontLoader = loader;
    const ptr = copyIn(manifest);
    let langs = '';
    for (let i = 0; languages && i < languages.length; i++)
        langs += (i ? ',' : '') + languages[i];
    const langPtr = copyInString(langs);
    X.ganglion_set_fallback_fonts(ptr, manifest.length, langPtr, TextEncoderPrototypeEncode(encoderUtf8, langs).length);
    X.ganglion_free(ptr);
    X.ganglion_free(langPtr);
};

api.addFallbackFont = (id, bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_add_fallback_font(id, ptr, bytes.length);
    X.ganglion_free(ptr);
};

// [subsets asked for, subsets installed].
api.fallbackFontCounts = () => {
    const packed = X.ganglion_fallback_font_counts() >>> 0;
    return [packed >>> 16, packed & 0xffff];
};

// A header of a response's headers given as an object (name -> value) or as [name, value] pairs; null when absent.
function headerValue(headers, name) {
    if (ArrayIsArray(headers)) {
        for (let i = 0; i < headers.length; i++)
            if (ArrayIsArray(headers[i]) && StringPrototypeToLowerCase(HostString(headers[i][0])) === name)
                return HostString(headers[i][1]);
        return null;
    }
    const keys = ObjectKeys(headers);
    for (let i = 0; i < keys.length; i++)
        if (StringPrototypeToLowerCase(keys[i]) === name)
            return HostString(headers[keys[i]]);
    return null;
}
// A nested segment's cross-origin isolation as its parent's iframe earns it (Host.cpp ganglion_set_embedder_isolation).
api.setEmbedderIsolation = (isolated, parentCoep, parentOrigin) => {
    const text = HostString(parentOrigin || '');
    const ptr = copyInString(text);
    try {
        X.ganglion_set_embedder_isolation(isolated ? 1 : 0, parentCoep === 'require-corp' ? 1 : parentCoep === 'credentialless' ? 2 : 0, ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
};
// The embedder policy of the document of `global` (the page's window, or a same-site frame realm's global; anything else: the
// page's): 'unsafe-none', 'require-corp' or 'credentialless'.
api.embedderPolicyOf = (global) => {
    let realm = 0;
    const cell = global !== undefined && global !== null ? WeakMapPrototypeGet(cellOf, global) : undefined;
    if (cell !== undefined && cell !== 0) {
        const mark = scratchTop;
        const o = slots(1);
        writeObject(o, cell);
        realm = X.ganglion_js_realm_of(o);
        scratchTop = mark;
    }
    const v = X.ganglion_realm_embedder_policy(realm);
    return v === 1 ? 'require-corp' : v === 2 ? 'credentialless' : 'unsafe-none';
};
api.start = () => {
    X.ganglion_start();
};

api.load = (url, bytes, mime, headers) => {
    // The response's headers that set the document's policies (COOP, COEP: docs/user-tests/coi.md), as "name: value" lines.
    if (headers && typeof headers === 'object') {
        let text = '';
        const names = ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-embedder-policy-report-only', 'cross-origin-resource-policy'];
        for (let i = 0; i < names.length; i++) {
            const v = headerValue(headers, names[i]);
            if (v !== null)
                text += names[i] + ': ' + v + '\n';
        }
        const ptr = copyInString(text);
        try {
            X.ganglion_set_next_document_headers(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
        } finally {
            X.ganglion_free(ptr);
        }
    }
    const urlPtr = copyInString(url);
    const bodyPtr = copyIn(bytes);
    const mimePtr = copyInString(mime || 'text/html');
    try {
        X.ganglion_load(urlPtr, TextEncoderPrototypeEncode(encoderUtf8, url).length, bodyPtr, bytes.length, mimePtr, TextEncoderPrototypeEncode(encoderUtf8, mime || 'text/html').length);
    } finally {
        X.ganglion_free(urlPtr);
        X.ganglion_free(bodyPtr);
        X.ganglion_free(mimePtr);
    }
};

// localStorage: the host takes the engine's copy (callbacks.storage(entries) receives [[key, value], ...]), and gives
// back what it persisted before the first document.
api.storageFlush = () => {
    X.ganglion_storage_flush();
};
// IndexedDB across reloads: the journal entries the segment kept (Uint8Arrays, oldest first), each replayed in turn (a damaged
// one is skipped and reported); then the state as one snapshot entry, which replaces them (compaction). After start(), before
// the first navigation.
api.idbRestore = (entries) => {
    let applied = 0, failed = 0;
    if (typeof X.ganglion_idb_import !== 'function')
        return { applied, failed: entries.length };
    for (const entry of entries) {
        const ptr = copyIn(entry);
        const r = X.ganglion_idb_import(ptr, entry.length);
        X.ganglion_free(ptr);
        if (r === 0)
            applied++;
        else
            failed++;
    }
    return { applied, failed };
};
api.idbSnapshot = () => {
    const out = X.ganglion_alloc(4);
    const len = X.ganglion_idb_export(out);
    views();
    const ptr = u32[out >>> 2];
    const bytes = Uint8ArraySlice(u8, ptr, ptr + len);
    X.ganglion_free(ptr);
    X.ganglion_free(out);
    return bytes;
};

api.storageRestore = (entries) => {
    let packed = '';
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i][0], value = entries[i][1];
        packed += StringFromCharCode(key.length & 0xFFFF, key.length >>> 16, value.length & 0xFFFF, value.length >>> 16) + key + value;
    }
    const ptr = stringToEngine(packed);
    try {
        X.ganglion_storage_restore(ptr, packed.length);
    } finally {
        X.ganglion_free(ptr);
    }
};

// The trust store for TLS: a PEM bundle (Mozilla's CA certificates), before the first https request.
api.setCaBundle = (bytes) => {
    const ptr = copyIn(bytes);
    try {
        X.ganglion_set_ca_bundle(ptr, bytes.length);
    } finally {
        X.ganglion_free(ptr);
    }
};

// Loads `url` over the engine's own network (redirects followed; an error page on failure). The outcome
// arrives through callbacks.navigated(finalUrl, status, errorOrNull).
api.navigate = (url) => {
    const ptr = copyInString(url);
    try {
        X.ganglion_navigate(ptr, TextEncoderPrototypeEncode(encoderUtf8, url).length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};

// Events of the host's TCP streams.
// `peer`: the address the stream connected to, when the host knows it (HTTP/2 connection pooling needs it).
api.tcpOpened = (id, peer) => {
    if (typeof peer === 'string' && peer.length > 0 && typeof X.ganglion_tcp_peer === 'function') {
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, peer);
        const ptr = copyIn(bytes);
        try {
            X.ganglion_tcp_peer(id, ptr, bytes.length);
        } finally {
            X.ganglion_free(ptr);
        }
    }
    X.ganglion_tcp_opened(id);
    api.pump();
};
api.tcpData = (id, bytes) => {
    const ptr = copyIn(bytes);
    try {
        X.ganglion_tcp_data(id, ptr, bytes.length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};
api.tcpClosed = (id, reason) => {
    X.ganglion_tcp_closed(id, reason | 0);
    api.pump();
};

// The engine's execution context stack as text (a debugging aid: Host.cpp ganglion_debug_context_stack).
api.contextStack = () => (typeof X.ganglion_debug_context_stack === 'function' ? cString(X.ganglion_debug_context_stack()) : '');

// Exports wrapped so that the first outermost call leaving the execution context stack non-empty is reported
// (options.debugContexts; never on in a shipped segment).
function contextCheckedExports(exports, report) {
    const wrapped = { __proto__: null };
    let depth = 0;
    let entered = 0; // ganglion_js_enter leaves one context pushed until its ganglion_js_leave
    let reported = false;
    const skip = new Set(['ganglion_debug_context_depth', 'ganglion_debug_context_stack', 'memory', 'ganglion_malloc', 'ganglion_free']);
    for (const name of Object.keys(exports)) {
        const f = exports[name];
        if (typeof f !== 'function' || skip.has(name)) {
            wrapped[name] = f;
            continue;
        }
        wrapped[name] = function () {
            depth++;
            if (name === 'ganglion_js_leave' || name === 'ganglion_js_leave_deferring_microtasks')
                entered--;
            try {
                return ReflectApply(f, undefined, arguments);
            } catch (e) {
                // A host exception that unwound through the engine's frames: no C++ cleanup ran under it.
                if (!reported && report)
                    report('ganglion: an exception unwound through ' + name + ' at depth ' + depth + ': ' + (e && e.stack ? e.stack : String(e)), name, '');
                throw e;
            } finally {
                depth--;
                if (name === 'ganglion_js_enter' || name === 'ganglion_js_enter_realm')
                    entered++;
                if (depth === 0 && !reported && exports.ganglion_debug_context_depth() !== entered) {
                    reported = true;
                    views();
                    const text = cString(exports.ganglion_debug_context_stack());
                    const message = 'ganglion: execution contexts left on the stack after ' + name + ':\n' + text;
                    if (report) report(message, name, text);
                    else console.error(message);
                }
            }
        };
    }
    return wrapped;
}

// A deliberate verification failure in the engine (tests of the host's handling of a stopped engine).
api.debugTrap = () => {
    X.ganglion_debug_trap();
};

// { bytesReceived, bytesSent, connections, tlsHandshakes, tlsHandshakeMs, tlsHandshakeCpuMs, requests, failures, caCertificates }
api.netStats = () => ({ __proto__: null,
    bytesReceived: X.ganglion_net_stats(0), bytesSent: X.ganglion_net_stats(1), connections: X.ganglion_net_stats(2),
    tlsHandshakes: X.ganglion_net_stats(3), tlsHandshakeMs: X.ganglion_net_stats(4), tlsHandshakeCpuMs: X.ganglion_net_stats(5),
    requests: X.ganglion_net_stats(6), failures: X.ganglion_net_stats(7), caCertificates: X.ganglion_net_stats(8), inFlight: X.ganglion_net_stats(9),
    h2Connections: X.ganglion_net_stats(11), h2Streams: X.ganglion_net_stats(12), h2Pooled: X.ganglion_net_stats(13) });

// What a host name resolves to, as the host learned it (an array of address strings; empty forgets it): with the stream's
// peer address, what HTTP/2 connection pooling decides by.
api.netDns = (host, addresses) => {
    const hostBytes = TextEncoderPrototypeEncode(encoderUtf8, String(host));
    let list = '';
    for (let i = 0; i < addresses.length; i++)
        list += String(addresses[i]) + '\n';
    const listBytes = TextEncoderPrototypeEncode(encoderUtf8, list);
    const hostPtr = copyIn(hostBytes);
    const listPtr = copyIn(listBytes);
    try {
        X.ganglion_net_dns(hostPtr, hostBytes.length, listPtr, listBytes.length);
    } finally {
        X.ganglion_free(hostPtr);
        X.ganglion_free(listPtr);
    }
};

// Logs every connection and waiting request through the engine log (a stuck page).
api.netDump = () => { X.ganglion_net_stats(10); };

// Host fetches the engine has not received the answer to yet (a resolved promise still counts until its
// reaction has delivered the bytes): a host that waits for the engine to settle waits for this too.
api.pendingHostFetches = () => pendingHostFetches;

function headerTextOf(headers) {
    let headerText = '';
    if (ArrayIsArray(headers)) {
        for (let i = 0; i < headers.length; i++)
            headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    } else {
        for (const name of ObjectKeys(headers))
            headerText += name + ': ' + headers[name] + '\n';
    }
    return headerText;
}

// A host response whose body streams in: `read()` resolves { done, value: Uint8Array } as a stream reader's does. The
// engine has the headers at once and each chunk as it comes (a media element demuxes before the end, Media.cpp).
api.fetchStreamed = (id, status, headers, read) => {
    const headerText = headerTextOf(headers);
    const headerPtr = copyInString(headerText);
    try {
        X.ganglion_fetch_headers(id, status, headerPtr, TextEncoderPrototypeEncode(encoderUtf8, headerText).length);
    } finally {
        X.ganglion_free(headerPtr);
    }
    api.pump();
    const next = () => PromisePrototypeThen(read(), (r) => {
        if (pendingFetches[id] === undefined)
            return;
        if (r.done) {
            pendingHostFetches--;
            delete pendingFetches[id];
            X.ganglion_fetch_end(id);
            api.pump();
            return;
        }
        const bytes = r.value instanceof globalThis.Uint8Array ? r.value : new (globalThis.Uint8Array)(r.value);
        const ptr = copyIn(bytes);
        try {
            X.ganglion_fetch_data(id, ptr, bytes.length);
        } finally {
            X.ganglion_free(ptr);
        }
        api.pump();
        next();
    }, (error) => { if (pendingFetches[id] !== undefined) api.fetchFailed(id, String(error && error.message || error)); });
    next();
};

api.fetchDone = (id, status, headers, body) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    const headerText = headerTextOf(headers);
    const bytes = body instanceof globalThis.Uint8Array ? body : new (globalThis.Uint8Array)(body);
    const headerPtr = copyInString(headerText);
    const bodyPtr = copyIn(bytes);
    try {
        X.ganglion_fetch_done(id, status, headerPtr, TextEncoderPrototypeEncode(encoderUtf8, headerText).length, bodyPtr, bytes.length);
    } finally {
        X.ganglion_free(headerPtr);
        X.ganglion_free(bodyPtr);
    }
    api.pump();
};

// A fetch the host claimed goes to the engine's own network after all (ganglion_fetch_network).
api.fetchNetwork = (id) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    X.ganglion_fetch_network(id);
    api.pump();
};

// A request on the engine's own network outside any document (a page service worker's fetch): no CORS or redirects here.
// `cookies`: the caller's credentials mode includes cookies for this URL, so the engine adds the jar's and stores the response's
// (Set-Cookie never comes back). Resolves { status, headers: [[name, value]], body: Uint8Array }; rejects with the network
// error's message.
api.netRequest = (method, url, headers, body, cookies) => new HostPromise((resolve, reject) => {
    const id = nextNetRequest++;
    pendingNetRequests[id] = { __proto__: null, resolve, reject };
    let headerText = '';
    for (let i = 0; i < headers.length; i++)
        headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    const bytes = body ? (body instanceof globalThis.Uint8Array ? body : new (globalThis.Uint8Array)(body)) : new (globalThis.Uint8Array)(0);
    const m = copyInString(method), u = copyInString(url), h = copyInString(headerText), b = copyIn(bytes);
    try {
        X.ganglion_net_request(id, m, TextEncoderPrototypeEncode(encoderUtf8, method).length, u, TextEncoderPrototypeEncode(encoderUtf8, url).length, h, TextEncoderPrototypeEncode(encoderUtf8, headerText).length, b, bytes.length, cookies === true ? 1 : 0);
    } finally {
        X.ganglion_free(m); X.ganglion_free(u); X.ganglion_free(h); X.ganglion_free(b);
    }
    api.pump();
});

// A tunnel on the engine's own network (docs/architecture.md, "WebSockets"): an HTTP/1.1 upgrade request (GET, `headers` as
// [[name, value]]) to an http(s) URL; after a 101 the connection carries the upgraded protocol, TLS inside the engine as for
// any request. handlers: { onOpen(status, reason, headers), onData(Uint8Array), onClose(errorText) } (errorText is '' for a
// normal end; onClose also reports an upgrade that failed). Returns the tunnel's id.
api.tunnelOpen = (url, headers, handlers) => {
    const id = nextTunnel++;
    tunnels[id] = handlers;
    let headerText = '';
    for (let i = 0; i < headers.length; i++)
        headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    const u = copyInString(url), h = copyInString(headerText);
    try {
        X.ganglion_tunnel_open(id, u, TextEncoderPrototypeEncode(encoderUtf8, url).length, h, TextEncoderPrototypeEncode(encoderUtf8, headerText).length);
    } finally {
        X.ganglion_free(u); X.ganglion_free(h);
    }
    api.pump();
    return id;
};
api.tunnelWrite = (id, bytes) => {
    if (tunnels[id] === undefined)
        return false;
    const data = bytes instanceof globalThis.Uint8Array ? bytes : new (globalThis.Uint8Array)(bytes);
    const ptr = copyIn(data);
    let ok;
    try {
        ok = X.ganglion_tunnel_write(id, ptr, data.length) !== 0;
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
    return ok;
};
api.tunnelClose = (id) => {
    if (tunnels[id] === undefined)
        return;
    delete tunnels[id];
    X.ganglion_tunnel_close(id);
    api.pump();
};

api.fetchFailed = (id, message) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    const ptr = copyInString(message);
    try {
        X.ganglion_fetch_failed(id, ptr, TextEncoderPrototypeEncode(encoderUtf8, message).length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};

// image: { width, height, frames: [{ rgba: Uint8Array (RGBA, straight alpha), duration }] }
api.imageDone = (id, image) => {
    delete pendingImages[id];
    const frames = image.frames;
    const count = frames.length;
    const frameBytes = image.width * image.height * 4;
    const pixelsPtr = X.ganglion_alloc(frameBytes * count);
    const durationsPtr = X.ganglion_alloc(4 * count);
    views();
    for (let f = 0; f < count; f++) {
        const rgba = frames[f].rgba;
        const base = pixelsPtr + f * frameBytes;
        // RGBA straight -> BGRA premultiplied
        for (let i = 0; i < frameBytes; i += 4) {
            const a = rgba[i + 3];
            u8[base + i] = (rgba[i + 2] * a + 127) / 255 | 0;
            u8[base + i + 1] = (rgba[i + 1] * a + 127) / 255 | 0;
            u8[base + i + 2] = (rgba[i] * a + 127) / 255 | 0;
            u8[base + i + 3] = a;
        }
        u32[(durationsPtr >>> 2) + f] = frames[f].duration | 0;
    }
    try {
        X.ganglion_image_done(id, image.width, image.height, count, pixelsPtr, durationsPtr);
    } finally {
        X.ganglion_free(pixelsPtr);
        X.ganglion_free(durationsPtr);
    }
    api.pump();
};

api.imageFailed = (id) => {
    delete pendingImages[id];
    X.ganglion_image_failed(id);
    api.pump();
};

// A display frame: LibWeb's rendering update (requestAnimationFrame and friends) runs on it.
api.renderingOpportunity = (ts) => X.ganglion_rendering_opportunity(ts || 0);

// Runs the engine's due timers and queued events; returns ms until the next timer or -1.
api.pump = () => {
    const r = X.ganglion_pump();
    syncNamedProperties(); // 45-surface.js: elements the tasks added or renamed
    return r;
};
api.microtaskTurnEnd = () => X.ganglion_microtask_turn_end();
api.setViewport = (width, height, dpr) => X.ganglion_set_viewport(width, height, dpr);
// prefers-color-scheme as the host browser answers it ('dark' or 'light').
// The host browser's screen (harness/segment/segment.js reads the segment document's `screen`): Screen, ScreenOrientation and
// the device-* media features answer with it; a change of orientation fires `change` at screen.orientation.
const ORIENTATION_TYPES = { __proto__: null, 'portrait-primary': 0, 'portrait-secondary': 1, 'landscape-primary': 2, 'landscape-secondary': 3 };
api.setScreen = (s) => {
    if (s === null || typeof s !== 'object' || typeof X.ganglion_set_screen !== 'function')
        return;
    const n = (v, d) => (typeof v === 'number' && v === v ? MathFloor(v) : d);
    X.ganglion_set_screen(n(s.width, 0), n(s.height, 0), n(s.availLeft, 0), n(s.availTop, 0), n(s.availWidth, 0), n(s.availHeight, 0), n(s.colorDepth, 24), (typeof s.orientationType === 'string' && ORIENTATION_TYPES[s.orientationType] !== undefined ? ORIENTATION_TYPES[s.orientationType] : -1), n(s.orientationAngle, 0), s.isExtended === true ? 1 : 0);
};
// The host browser's navigator.connection (segment.js): effectiveType, rtt, downlink and saveData for the page's NetworkInformation.
const EFFECTIVE_TYPES = { __proto__: null, 'slow-2g': 0, '2g': 1, '3g': 2, '4g': 3 };
api.setNetworkInformation = (c) => {
    if (c === null || typeof c !== 'object' || typeof X.ganglion_set_network_information !== 'function')
        return;
    const t = typeof c.effectiveType === 'string' && EFFECTIVE_TYPES[c.effectiveType] !== undefined ? EFFECTIVE_TYPES[c.effectiveType] : 3;
    X.ganglion_set_network_information(t, typeof c.rtt === 'number' ? c.rtt : 50, typeof c.downlink === 'number' ? c.downlink : 10, c.saveData === true ? 1 : 0);
};
// Web Audio's output goes to the host from now on (glue/engine/55-media.js), at the host's output rate (0: LibMedia's default).
api.setAudioOutput = (sampleRate) => { if (typeof X.ganglion_set_audio_output === 'function') X.ganglion_set_audio_output(typeof sampleRate === 'number' && sampleRate > 0 ? MathFloor(sampleRate) : 0); };
api.setColorScheme = (scheme) => { if (typeof X.ganglion_set_color_scheme === 'function') X.ganglion_set_color_scheme(scheme === 'dark' ? 1 : 0); };
api.needsPaint = () => !!X.ganglion_needs_paint();
api.needsPaintReasons = () => (typeof X.ganglion_needs_paint_reasons === 'function' ? X.ganglion_needs_paint_reasons() >>> 0 : 0);
api.frameWidth = () => X.ganglion_frame_width();
api.frameHeight = () => X.ganglion_frame_height();

// A copy of `n` bytes at `ptr` as a Uint8Array (never a view: linear memory stays private).
const Uint8ArrayPrototypeSet = uncurryThis(globalThis.Uint8Array.prototype.set);
function copyOutBytes(ptr, n) {
    views();
    const bytes = new (globalThis.Uint8Array)(n);
    Uint8ArrayPrototypeSet(bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + n));
    return bytes;
}

// Copies `n` bytes out of linear memory at `ptr` into a fresh Uint8ClampedArray (one typed-array copy; the
// subarray view is not retained).
function copyOut(ptr, n) {
    views();
    const pixels = new Uint8ClampedArray_(n);
    TypedArrayPrototypeSet(pixels, TypedArrayPrototypeSubarray(u8, ptr, ptr + n));
    return pixels;
}

function imageOf(ptr, width, height) {
    const pixels = copyOut(ptr, width * height * 4);
    if (HostImageData)
        return new HostImageData(pixels, width, height);
    return { __proto__: null, data: pixels, width, height };
}

// Paints what changed. Returns null when nothing could be painted, else { blit: {dx, dy}, x, y, width,
// height, image }: the host moves its copy of the frame by the blit (a scroll), then puts `image` at
// (x, y). `width`/`height` are 0 when nothing changed (the frame is as it was).
const HostJSONParse = globalThis.JSON.parse;
api.paint = () => {
    const ptr = X.ganglion_paint();
    if (!ptr)
        return null;
    if (typeof X.ganglion_compositor === 'function' && X.ganglion_compositor() !== 0)
        return layeredFrame();
    const x = X.ganglion_dirty_x(), y = X.ganglion_dirty_y();
    const width = X.ganglion_dirty_width(), height = X.ganglion_dirty_height();
    const blit = { __proto__: null, dx: X.ganglion_blit_dx(), dy: X.ganglion_blit_dy() };
    const image = width > 0 && height > 0 ? imageOf(ptr, width, height) : null;
    return { __proto__: null, blit, x, y, width, height, image };
};

// The compositor (docs/compositor.md): 'flat' (one frame, api.paint as above), 'layers' (tiles; backdrop filters
// rastered in the engine) or 'gpu' (tiles; blur/saturate backdrop filters for the carapace's WebGL2).
api.setCompositor = (mode) => { if (typeof X.ganglion_set_compositor === 'function') X.ganglion_set_compositor(mode === 'gpu' ? 2 : mode === 'layers' ? 1 : 0); };
// Raw tiles (the WebGL2 carapace): each dirty tile part as { width, height, bgra: Uint8Array } of BGRA premultiplied
// bytes, not an ImageData of RGBA straight alpha (no conversion in the engine, no ImageBitmap in the Worker).
let rawTiles = false;
api.setRawTiles = (on) => { if (typeof X.ganglion_set_raw_tiles === 'function') { X.ganglion_set_raw_tiles(on ? 1 : 0); rawTiles = !!on; } return rawTiles; };
api.compositor = () => (typeof X.ganglion_compositor === 'function' ? ['flat', 'layers', 'gpu'][X.ganglion_compositor()] || 'flat' : 'flat');
// A layered paint: { layers: the tree (JSON from the engine), tiles: [{ layer, i, j, x, y, width, height, image }], bytes }.
function layeredFrame() {
    const tree = HostJSONParse(bytesToString(X.ganglion_layers_json(), X.ganglion_layers_json_length()));
    const tiles = [];
    let bytes = 0;
    const dirty = tree.dirty;
    for (let k = 0; k < dirty.length; k++) {
        const d = dirty[k];
        const width = d[5], height = d[6];
        tiles[k] = { __proto__: null, layer: d[0], i: d[1], j: d[2], x: d[3], y: d[4], width, height, image: rawTiles ? { __proto__: null, width, height, bgra: copyOutBytes(X.ganglion_layers_dirty_pixels(k), width * height * 4) } : imageOf(X.ganglion_layers_dirty_pixels(k), width, height) };
        bytes += width * height * 4;
    }
    return { __proto__: null, layers: tree, tiles, bytes, blit: { __proto__: null, dx: 0, dy: 0 }, x: 0, y: 0, width: 0, height: 0, image: null };
}
api.layerStats = () => ({ __proto__: null, rasterMs: X.ganglion_layers_stats(0), splitMs: X.ganglion_layers_stats(1), layers: X.ganglion_layers_stats(2), tiles: X.ganglion_layers_stats(3), tilesRastered: X.ganglion_layers_stats(4), bytes: X.ganglion_layers_stats(5), flattened: !!X.ganglion_layers_stats(6), tilesRasteredVisible: X.ganglion_layers_stats(7), convertMs: X.ganglion_layers_stats(8), layoutMs: X.ganglion_layers_stats(9), recordMs: X.ganglion_layers_stats(10) });
// Replay profiling (patch 0085): on/off, and per command type [type, ms, count] since the last call.
api.replayProfile = (on) => { if (typeof X.ganglion_replay_profile_enable === 'function') X.ganglion_replay_profile_enable(on ? 1 : 0); };
api.replayProfileTake = () => (typeof X.ganglion_replay_profile_take === 'function' ? cString(X.ganglion_replay_profile_take()).split(';').filter(Boolean).map((e) => e.split(':').map(Number)) : []);

// The whole frame as an ImageData (a copy out of linear memory), or null before the first paint.
api.frame = () => {
    const ptr = X.ganglion_frame_rgba();
    if (!ptr)
        return null;
    return imageOf(ptr, X.ganglion_frame_width(), X.ganglion_frame_height());
};

// { painted, rasters, fullRasters, blits } since start.
api.paintCounts = () => ({ __proto__: null, painted: X.ganglion_paint_counts(0), rasters: X.ganglion_paint_counts(1), fullRasters: X.ganglion_paint_counts(2), blits: X.ganglion_paint_counts(3),
    lastLayoutMs: X.ganglion_paint_counts(4), lastRecordMs: X.ganglion_paint_counts(5), lastRasterMs: X.ganglion_paint_counts(6), lastConvertMs: X.ganglion_paint_counts(7) });

// The pointer the next mouse call comes from (Pointer Events): 'mouse', 'pen' or 'touch', its id, contact size, pressure
// (negative: not reported) and whether it is primary.
api.pointer = (type, id, width, height, pressure, isPrimary) => {
    if (typeof X.ganglion_pointer === 'function')
        X.ganglion_pointer(type === 'touch' ? 2 : type === 'pen' ? 1 : 0, id | 0, +width || 1, +height || 1, typeof pressure === 'number' ? pressure : -1, isPrimary !== false);
};
api.mouse = (kind, x, y, button, buttons, modifiers) => X.ganglion_mouse(kind, x, y, button | 0, buttons | 0, modifiers | 0);
api.wheel = (x, y, dx, dy) => X.ganglion_wheel(x, y, dx, dy);
// A mouse event with a screen position of its own (movementX/Y are screen deltas; under the pointer lock the client position stays).
api.mouseScreen = (kind, x, y, sx, sy, button, buttons, modifiers) => X.ganglion_mouse_screen(kind, x, y, sx, sy, button | 0, buttons | 0, modifiers | 0);
api.fullscreenChanged = (on) => X.ganglion_fullscreen_changed(on ? 1 : 0);
// kind 0: the answer to a lock request (error 0 locked, 1 refused, 2 unsupported options); kind 1: the host's lock ended.
api.pointerLockResult = (kind, error) => X.ganglion_pointer_lock_result(kind | 0, error | 0);
// Host gamepads (the carapace polls navigator.getGamepads): handle > 0, axes -1..1 and button values 0..1 as the host gives them.
api.gamepadConnected = (handle, id, standard, axisCount, buttonCount) => {
    const ptr = copyInString(id);
    try {
        return X.ganglion_gamepad_connected(handle >>> 0, ptr, TextEncoderPrototypeEncode(encoderUtf8, id).length, standard ? 1 : 0, axisCount | 0, buttonCount | 0) === 1;
    } finally {
        X.ganglion_free(ptr);
    }
};
api.gamepadState = (handle, axes, buttons) => {
    const na = axes.length, nb = buttons.length;
    const ptr = X.ganglion_alloc((na + nb) * 2 + 2);
    try {
        views();
        const put = (at, v) => { u8[ptr + at * 2] = v & 255; u8[ptr + at * 2 + 1] = (v >> 8) & 255; };
        for (let i = 0; i < na; i++)
            put(i, MathMax(-32768, MathMin(32767, MathFloor(+axes[i] * 32767 + 0.5))) | 0);
        for (let i = 0; i < nb; i++)
            put(na + i, MathMax(0, MathMin(32767, MathFloor(+buttons[i] * 32767 + 0.5))) | 0);
        X.ganglion_gamepad_state(handle >>> 0, ptr, na, ptr + na * 2, nb);
    } finally {
        X.ganglion_free(ptr);
    }
};
api.gamepadDisconnected = (handle) => X.ganglion_gamepad_disconnected(handle >>> 0);
api.scrollBy = (dx, dy) => X.ganglion_scroll_by(dx, dy);
// Threaded scroll: the carapace scrolled node `node` by (dx, dy) CSS px for a wheel at (x, y); see Host.cpp.
api.scrollSync = (seq, node, x, y, dx, dy) => { if (typeof X.ganglion_scroll_sync === 'function') X.ganglion_scroll_sync(seq >>> 0, node >>> 0, +x || 0, +y || 0, +dx || 0, +dy || 0); };
api.key = (kind, keyCode, modifiers, codePoint) => X.ganglion_key(kind, keyCode | 0, modifiers | 0, codePoint >>> 0);
api.collect = (force) => !!X.ganglion_collect(!!force);
api.memoryBytes = () => (views(), viewBuffer.byteLength);
api.fingerprint = () => cString(X.ganglion_fingerprint());
api.debug = (flags) => X.ganglion_debug(flags | 0);
api.renderBlocked = () => (typeof X.ganglion_render_blocked === 'function' ? X.ganglion_render_blocked() : -1);
api.setLog = (fn) => { engineLog = fn; };

// ===== glue/engine/40-bridge.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the mirror (docs/phase2.md section 2). Page JavaScript runs on this realm's V8;
// the DOM lives in the engine. The mirror builds a V8 class for every interface from the prototype
// objects LibWeb's own generated bindings made inside the runtime, calls their native functions
// through one export (ganglion_js_invoke), converts values at the boundary, and hands the engine
// "foreign" cells for the page's own objects and functions. Runtime values are 64-bit NaN-boxed words
// in linear memory; the tags are Runtime.h's.
//
// Everything here runs with page code in the same realm: captured primordials only, null-prototype
// tables, no views of linear memory escape.

const HostPromise_ = globalThis.Promise;
const HostJSON = globalThis.JSON;
const HostProxy = globalThis.Proxy;
const HostWeakSet = globalThis.WeakSet;
const HostMap = globalThis.Map;
const HostRangeError = globalThis.RangeError;
const HostSyntaxError = globalThis.SyntaxError;
const HostReferenceError = globalThis.ReferenceError;
const HostEvalError = globalThis.EvalError;
const HostURIError = globalThis.URIError;
const HostAggregateError = globalThis.AggregateError;
const ReflectGet = HostReflect.get;
const ReflectHas = HostReflect.has;
const ReflectOwnKeys = HostReflect.ownKeys;
const ReflectDefineProperty = HostReflect.defineProperty;
const ReflectDeleteProperty = HostReflect.deleteProperty;
const ReflectGetPrototypeOf = HostReflect.getPrototypeOf;
const ObjectCreate = HostObject.create;
const ArrayIsArray = Array.isArray;
const ArrayPrototypePush = uncurryThis(Array.prototype.push);
const ArrayPrototypePop = uncurryThis(Array.prototype.pop);
const MapPrototypeGet = uncurryThis(HostMap.prototype.get);
const MapPrototypeSet = uncurryThis(HostMap.prototype.set);
const MapPrototypeDelete = uncurryThis(HostMap.prototype.delete);
const ArrayFromList = Array.from;
const MapPrototypeHas = uncurryThis(HostMap.prototype.has);
const HostSet = globalThis.Set;
const SetPrototypeAdd = uncurryThis(HostSet.prototype.add);
const SetPrototypeHas = uncurryThis(HostSet.prototype.has);
const MapPrototypeEntries = uncurryThis(HostMap.prototype.entries);
const SetPrototypeValues = uncurryThis(HostSet.prototype.values);
const WeakMapPrototypeDelete = uncurryThis(WeakMap.prototype.delete);
const WeakSetPrototypeAdd = uncurryThis(HostWeakSet.prototype.add);
const WeakSetPrototypeHas = uncurryThis(HostWeakSet.prototype.has);
const JSONParse = HostJSON.parse;
const JSONStringify = HostJSON.stringify;
const PromiseResolve_ = HostPromise_.resolve;
const FunctionPrototypeToString = HostFunction.prototype.toString;
const SymbolIterator = HostSymbol.iterator;
const SymbolFor = HostSymbol.for;
const StringPrototypeSlice = uncurryThis(HostString.prototype.slice);
const latin1Decoder = new TextDecoder('latin1');
const utf16Decoder = new TextDecoder('utf-16le');
const G = globalThis;

// --- Binary data: ArrayBuffers and typed arrays cross by value ---------------------------------------------------
// Captured before any page script runs. The runtime's buffers live in linear memory, which never leaves the glue,
// so a buffer is copied on each crossing (a page that hands the engine a view to write into sees no writes).
const BufferUint8Array = globalThis.Uint8Array;
const bufferViewProto = ObjectGetPrototypeOf(BufferUint8Array.prototype);   // %TypedArray%.prototype
const bufferGetter = (proto, name) => ObjectGetOwnPropertyDescriptor(proto, name).get;
const ArrayBufferIsView = HostArrayBuffer.isView;
const ArrayBufferByteLength = uncurryThis(bufferGetter(HostArrayBuffer.prototype, 'byteLength'));
const ArrayBufferDetachedGet = ObjectGetOwnPropertyDescriptor(HostArrayBuffer.prototype, 'detached') ? bufferGetter(HostArrayBuffer.prototype, 'detached') : null;
const ArrayBufferDetached = ArrayBufferDetachedGet ? uncurryThis(ArrayBufferDetachedGet) : null;
const ArrayBufferTransfer = typeof HostArrayBuffer.prototype.transfer === 'function' ? uncurryThis(HostArrayBuffer.prototype.transfer) : null;
const TypedArrayBuffer = uncurryThis(bufferGetter(bufferViewProto, 'buffer'));
const TypedArrayByteOffset = uncurryThis(bufferGetter(bufferViewProto, 'byteOffset'));
const TypedArrayByteLength = uncurryThis(bufferGetter(bufferViewProto, 'byteLength'));
const TypedArrayTag = uncurryThis(ObjectGetOwnPropertyDescriptor(bufferViewProto, HostSymbol.toStringTag).get);
const DataViewBuffer = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'buffer'));
const DataViewByteOffset = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'byteOffset'));
const DataViewByteLength = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'byteLength'));
// Index = the runtime's typed array kind (Runtime.h); null where this V8 has no such class.
const BUFFER_NAMES = ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'BigUint64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'BigInt64Array', 'Float16Array', 'Float32Array', 'Float64Array'];
const BUFFER_CTORS = [];
const BUFFER_KIND_BY_NAME = ObjectCreate(null);
for (let i = 0; i < BUFFER_NAMES.length; i++) {
    BUFFER_CTORS[i] = globalThis[BUFFER_NAMES[i]] || null;
    BUFFER_KIND_BY_NAME[BUFFER_NAMES[i]] = i;
}

// --- Tags (Runtime.h) ------------------------------------------------------------------------------------
// The high 32 bits of a tagged value, as JS sees them after >>> 0 (unsigned), and the 16-bit tags.
const HI_UNDEFINED = 0x7FFE0000, HI_NULL = 0x7FFF0000, HI_BOOLEAN = 0x7FF90000, HI_INT32 = 0x7FFA0000;
const HI_OBJECT = 0xFFF90000, HI_STRING = 0xFFFA0000, HI_SYMBOL = 0xFFFB0000;
const TAG_UNDEFINED = 0x7FFE, TAG_NULL = 0x7FFF, TAG_BOOLEAN = 0x7FF9, TAG_INT32 = 0x7FFA, TAG_OBJECT = 0xFFF9, TAG_STRING = 0xFFFA, TAG_SYMBOL = 0xFFFB;
const WELL_KNOWN = ['asyncDispose', 'asyncIterator', 'dispose', 'hasInstance', 'isConcatSpreadable', 'iterator', 'match', 'matchAll', 'replace', 'replaceAll', 'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables'];
const PD_HAS_VALUE = 1, PD_HAS_GET = 2, PD_HAS_SET = 4, PD_HAS_WRITABLE = 8, PD_WRITABLE = 16, PD_HAS_ENUMERABLE = 32, PD_ENUMERABLE = 64, PD_HAS_CONFIGURABLE = 128, PD_CONFIGURABLE = 256, PD_PRESENT = 1024;

// --- Scratch memory: a bump allocator of 8-byte slots, saved and restored around every call ---------------
let scratchBase = 0, scratchTop = 0, scratchEnd = 0;
function scratchInit() {
    scratchBase = X.ganglion_alloc(1 << 16);
    scratchTop = scratchBase;
    scratchEnd = scratchBase + (1 << 16);
}
function slots(n) {
    const p = scratchTop;
    scratchTop += n * 8;
    if (scratchTop > scratchEnd)
        throw new HostError('ganglion: the glue ran out of scratch memory');
    return p;
}
function writeLoHi(p, lo, hi) {
    views();
    u32[p >>> 2] = lo;
    u32[(p >>> 2) + 1] = hi;
}
function writeUndefined(p) { writeLoHi(p, 0, HI_UNDEFINED); }
function writeObject(p, cell) { writeLoHi(p, cell, HI_OBJECT); }

// --- Strings -----------------------------------------------------------------------------------------------
function readRuntimeString(p) {
    const dataPtr = X.ganglion_v_string_data(p, scratchTop, scratchTop + 4);
    views();
    const length = u32[scratchTop >>> 2];
    const ascii = u32[(scratchTop >>> 2) + 1];
    if (length === 0)
        return '';
    if (ascii) {
        if (length < 64) {
            let s = '';
            for (let i = 0; i < length; i++)
                s += StringFromCharCode(u8[dataPtr + i]);
            return s;
        }
        const copy = new (globalThis.Uint8Array)(length);
        for (let i = 0; i < length; i++)
            copy[i] = u8[dataPtr + i];
        return TextDecoderPrototypeDecode(latin1Decoder, copy);
    }
    return utf16ToString(dataPtr, length);
}
// Writes a JS string as UTF-16 into fresh engine memory; returns the pointer (the caller frees).
function stringToEngine(s) {
    const n = s.length;
    const ptr = X.ganglion_alloc(n * 2 + 2);
    views();
    const base = ptr >>> 1;
    const u16 = new Uint16Array(viewBuffer);
    for (let i = 0; i < n; i++)
        u16[base + i] = StringPrototypeCharCodeAt(s, i);
    return ptr;
}
function writeString(p, s) {
    const ptr = stringToEngine(s);
    X.ganglion_v_string_from_utf16(ptr, s.length, p);
    X.ganglion_free(ptr);
}
function readText(ptr, length, ascii) {
    views();
    if (ascii) {
        const copy = new (globalThis.Uint8Array)(length);
        for (let i = 0; i < length; i++)
            copy[i] = u8[ptr + i];
        return TextDecoderPrototypeDecode(latin1Decoder, copy);
    }
    return utf16ToString(ptr, length);
}

// --- Keys ----------------------------------------------------------------------------------------------------
const internedKeys = new HostMap();       // string -> key bits (our interned fly strings, alive for good)
const wellKnownKeys = safeArray();         // index -> key bits
const wellKnownSymbols = safeArray();      // index -> V8 symbol
const symbolKeys = new HostMap();          // V8 symbol -> key bits (page symbols given to the engine)
const symbolsByCell = new HostMap();       // runtime symbol cell -> V8 symbol
function isArrayIndex(s) {
    const n = s.length;
    if (n === 0 || n > 10)
        return false;
    let v = 0;
    for (let i = 0; i < n; i++) {
        const c = StringPrototypeCharCodeAt(s, i);
        if (c < 48 || c > 57 || (i === 0 && c === 48 && n > 1))
            return false;
        v = v * 10 + (c - 48);
    }
    return v < 4294967295;
}
// LibJS keeps an index as a number key only up to MAX_NUMBER_KEY_INDEX, 2 ** 30 - 1 on wasm32 (the index shares a pointer-sized
// word with two flag bits); a larger index is a string key there. ganglion_key_index(i) for a larger i wrapped around to
// i mod 2 ** 30: childNodes[2 ** 30] read childNodes[0] (secfuzz B2).
const MAX_NUMBER_KEY_INDEX = 0x3fffffff;
function indexKey(i) {
    return i <= MAX_NUMBER_KEY_INDEX ? X.ganglion_key_index(i) : keyBits(HostString(i));
}
function keyBits(key) {
    if (typeof key === 'string') {
        if (isArrayIndex(key) && +key <= MAX_NUMBER_KEY_INDEX)
            return X.ganglion_key_index(+key);
        let bits = MapPrototypeGet(internedKeys, key);
        if (bits === undefined) {
            const ptr = stringToEngine(key);
            bits = X.ganglion_key_intern(ptr, key.length);
            X.ganglion_free(ptr);
            MapPrototypeSet(internedKeys, key, bits);
        }
        return bits;
    }
    if (typeof key === 'symbol') {
        let bits = MapPrototypeGet(symbolKeys, key);
        if (bits !== undefined)
            return bits;
        for (let i = 0; i < WELL_KNOWN.length; i++) {
            if (wellKnownSymbols[i] === key) {
                bits = wellKnownKeys[i];
                MapPrototypeSet(symbolKeys, key, bits);
                return bits;
            }
        }
        const mark = scratchTop;
        const p = slots(1);
        const desc = key.description === undefined ? '' : key.description;
        const ptr = stringToEngine(desc);
        X.ganglion_v_symbol_create(ptr, desc.length, p);
        X.ganglion_free(ptr);
        bits = X.ganglion_key_from_symbol(p);
        views();
        MapPrototypeSet(symbolsByCell, u32[p >>> 2], key);
        scratchTop = mark;
        MapPrototypeSet(symbolKeys, key, bits);
        return bits;
    }
    return keyBits(HostString(key));
}
function keyToJS(bits) {
    const kind = X.ganglion_key_kind(bits);
    if (kind === 3)
        return HostString(X.ganglion_key_number(bits));
    const mark = scratchTop;
    const p = slots(1);
    X.ganglion_key_value(bits, p);
    const v = toJS(p);
    scratchTop = mark;
    return v;
}

// --- Handles: the page's values the engine holds ---------------------------------------------------------------
const handles = safeArray();
const freeHandles = safeArray();
const handleOf = new WeakMap();           // object/function -> handle
const foreignCellByHandle = safeArray();  // handle -> cell address while the cell lives
function handleFor(value) {
    let h = WeakMapPrototypeGet(handleOf, value);
    if (h !== undefined)
        return h;
    h = freeHandles.length ? ArrayPrototypePop(freeHandles) : handles.length;
    handles[h] = value;
    WeakMapPrototypeSet(handleOf, value, h);
    return h;
}

// --- Wrappers: the engine's objects as page values ----------------------------------------------------------------
const cellOf = new WeakMap();             // wrapper (or its proxy) -> cell address
const wrapperByCell = new HostMap();      // cell address -> wrapper (strong until the GC milestone)
const classByProto = new HostMap();       // prototype cell -> class
const functionByCell = new HostMap();     // native function cell -> page-visible function
const nativeFunctions = new HostWeakSet();// every function the mirror made (for Function.prototype.toString)
const engineErrors = new HostWeakSet();   // errors errorToJS made from the engine's: the ones a binding rewrites into Chrome's (45-surface.js)
const classByName = new HostMap();        // interface name -> class
let globalCell = 0;
let objectPrototypeCell = 0;
let documentsReset = 0;
let scriptsRun = 0;
let scriptingOn = false;

// The runtime object `cell` now has a page value: remember it and keep the cell alive (its address is
// the key; a collected cell's address would be reused).
function cacheWrapper(cell, value) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    X.ganglion_v_root(p);
    scratchTop = mark;
    MapPrototypeSet(wrapperByCell, cell, value);
}

// --- Value conversion ----------------------------------------------------------------------------------------------
function toJS(p) {
    views();
    const lo = u32[p >>> 2];
    const hi = u32[(p >>> 2) + 1];
    const tag = hi >>> 16;
    if ((tag & 0x7FF8) === 0x7FF8 && (tag & 7) !== 0) {
        switch (tag) {
        case TAG_UNDEFINED: return undefined;
        case TAG_NULL: return null;
        case TAG_BOOLEAN: return lo !== 0;
        case TAG_INT32: return lo | 0;
        case TAG_STRING: return readRuntimeString(p);
        case TAG_SYMBOL: return symbolToJS(p, lo);
        case TAG_OBJECT: return objectToJS(p, lo);
        default: return undefined; // accessor, empty: nothing a page should see
        }
    }
    return f64[p >>> 3];
}

function symbolToJS(p, cell) {
    const known = MapPrototypeGet(symbolsByCell, cell);
    if (known !== undefined)
        return known;
    const which = X.ganglion_v_symbol_well_known(p);
    if (which >= 0)
        return wellKnownSymbols[which];
    const mark = scratchTop;
    const d = slots(1);
    X.ganglion_v_symbol_description(p, d);
    const description = toJS(d);
    scratchTop = mark;
    const sym = HostSymbol(description);
    MapPrototypeSet(symbolsByCell, cell, sym);
    return sym;
}

// The cell of the principal window's WindowProxy: what `window` is on the global.
let principalWindowProxy = 0;
function principalWindowProxyCell() {
    if (principalWindowProxy !== 0)
        return principalWindowProxy;
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, globalCell);
    const threw = X.ganglion_v_get(o, keyBits('window'), r);
    views();
    if (!threw && (u32[(r >>> 2) + 1] >>> 16) === TAG_OBJECT)
        principalWindowProxy = u32[r >>> 2];
    scratchTop = mark;
    return principalWindowProxy;
}

// The WindowProxy of a frame's window (iframe.contentWindow, a child's `parent`...): the engine's WindowProxy applies the
// same-origin and cross-origin rules itself, so the page's object forwards every operation to it. The frame's realm has
// no V8 context of its own (its scripts do not run, Bridge.cpp), so there is no global to hand out.
function frameWindow(cell, holder) {
    const target = ObjectCreate(null);
    // The engine's WindowProxy asks for the current window, so each operation runs with a script context under it, as
    // the page's calls into the engine do (idleEntry): the context of the realm that holds this stand-in (`holder`, its
    // global's cell), the realm whose code uses it. A cross-origin method read here is made in that realm (HTML
    // CrossOriginGetOwnPropertyHelper: "created in the current Realm Record"), so calling it later enters that realm too,
    // and the incumbent settings object of a frame's `parent.postMessage(...)` is the frame's (the event's source).
    const get = (key) => {
        const entered = idleEntry(holder);
        try {
            return vGet(cell, key);
        } finally {
            idleExit(entered);
        }
    };
    // Every operation that reaches the engine's WindowProxy (its [[GetPrototypeOf]] checks the origin against the
    // current settings object, which needs a context: `x instanceof Window` after an `await`).
    const inRealm = (f) => {
        const entered = idleEntry(holder);
        try {
            return f();
        } finally {
            idleExit(entered);
        }
    };
    const handler = {
        __proto__: null,
        get(t, key) { return get(key); },
        set(t, key, value) {
            const entered = idleEntry(holder);
            try {
                vSetEntered(cell, key, value);
            } finally {
                idleExit(entered);
            }
            return true;
        },
        has(t, key) { return get(key) !== undefined || inRealm(() => vOwnProperty(cell, keyBits(key))) !== null; },
        ownKeys() {
            const keys = inRealm(() => vOwnKeys(cell));
            const out = [];
            for (let i = 0; i < keys.length; i++)
                ArrayPrototypePush(out, keyToJS(keys[i]));
            return out;
        },
        getOwnPropertyDescriptor(t, key) {
            const prop = inRealm(() => vOwnProperty(cell, keyBits(key)));
            if (prop === null)
                return undefined;
            return { value: get(key), writable: true, enumerable: (prop.flags & PD_ENUMERABLE) !== 0, configurable: true };
        },
        getPrototypeOf() {
            const protoCell = inRealm(() => vPrototypeCell(cell));
            const cls = protoCell === 0 ? null : classForPrototype(protoCell);
            return cls === null ? null : cls.prototype;
        },
        defineProperty(t, key, descriptor) {
            if ('value' in descriptor)
                handler.set(t, key, descriptor.value);
            return true;
        },
        deleteProperty() { return false; },
        setPrototypeOf() { return false; },
        preventExtensions() { return false; },
    };
    const proxy = new HostProxy(target, handler);
    WeakMapPrototypeSet(cellOf, proxy, cell);
    // Kept apart from the wrapper cache: the same WindowProxy is its realm's own window to a script of its origin (the
    // frame's code reading `window`), and this stand-in only to a script of another origin (windowProxyToJS).
    rootAccessorCell(cell);
    let byHolder = MapPrototypeGet(standInByCell, cell);
    if (byHolder === undefined) {
        byHolder = new HostMap();
        MapPrototypeSet(standInByCell, cell, byHolder);
    }
    MapPrototypeSet(byHolder, holder, proxy);
    return proxy;
}
// The principal window as the realm asking sees it: itself to its own code and to a same-origin frame's, the
// engine-checked stand-in to a cross-origin frame's code (a cross-origin same-site frame's `parent`, `top`, an event's
// source): HTML's WindowProxy checks are relative to the accessing realm, and the stand-in's methods act in that realm.
function principalWindowFor(cell) {
    const asking = currentGlobalCell();
    if (asking === 0 || asking === globalCell)
        return G;
    let own, principal;
    try {
        own = vGet(asking, 'origin');
        principal = vGet(globalCell, 'origin');
    } catch {
        return G;
    }
    if (own === principal)
        return G;
    const wp = principalWindowProxyCell();
    const byHolder = MapPrototypeGet(standInByCell, wp);
    const standIn = byHolder !== undefined ? MapPrototypeGet(byHolder, asking) : undefined;
    return standIn !== undefined ? standIn : frameWindow(wp, asking);
}
const standInByCell = new HostMap(); // a frame's WindowProxy cell -> (the holding realm's global cell -> its cross-origin stand-in)
const rootedAccessorCells = new HostSet();
function rootAccessorCell(cell) {
    if (SetPrototypeHas(rootedAccessorCells, cell))
        return;
    SetPrototypeAdd(rootedAccessorCells, cell);
    rootCell(cell);
}
function rootCell(cell) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    X.ganglion_v_root(p);
    scratchTop = mark;
}

function cacheWrapperValue(cell, value) {
    return value; // a Date is a value: not cached, a page that changes its copy does not change the engine's
}

function objectToJS(p, cell) {
    if (cell === globalCell)
        return frameRealmsOn ? principalWindowFor(cell) : G;
    const cached = MapPrototypeGet(wrapperByCell, cell);
    if (cached === G && frameRealmsOn)
        return principalWindowFor(cell);
    if (cached !== undefined)
        return cached;
    if (frameRealmsOn) {
        // A frame's Window itself (its global object): the page sees its WindowProxy (55-realms.js).
        const record = MapPrototypeGet(realmByWindowCell, cell);
        if (record !== undefined)
            return record.proxy;
    }
    const kind = X.ganglion_v_object_kind(p);
    switch (kind) {
    case 1:
    case 8:
        // The window's WindowProxy is the global as the page sees it (one window per segment). The WindowProxy of
        // a frame's window is another object, mirrored like any other: its document, location and the rest are
        // the frame's, not the page's.
        if (vClassName(cell) === 'WindowProxy') {
            if (cell === principalWindowProxyCell()) {
                cacheWrapper(cell, G);
                return G;
            }
            // A same-origin frame's window is its realm's (55-realms.js); any other, the engine-checked stand-in.
            const realmWindow = windowProxyToJS(cell);
            if (realmWindow !== null)
                return realmWindow;
            // One stand-in per realm that holds it (HTML: a cross-origin WindowProxy's properties are per current realm).
            const holder = frameRealmsOn ? currentGlobalCell() || globalCell : globalCell;
            const byHolder = MapPrototypeGet(standInByCell, cell);
            const standIn = byHolder !== undefined ? MapPrototypeGet(byHolder, holder) : undefined;
            return standIn !== undefined ? standIn : frameWindow(cell, holder);
        }
        if (kind === 1)
            return wrap(p, cell);
        // A host object that wraps nothing but has an interface's prototype (the iterator of URLSearchParams.keys()) is
        // that interface's object, not a snapshot of its own properties: its methods are on the prototype.
        if (classForPrototype(vPrototypeCell(cell)) !== null)
            return wrap(p, cell);
        return otherToJS(p, cell, 0);
    case 2: case 3: return handles[X.ganglion_v_foreign_handle(p)];
    case 4: return functionToJS(p, cell);
    case 5: return arrayToJS(p);
    case 10: return bufferToJS(p);
    case 11: return cacheWrapperValue(cell, new HostDate(X.ganglion_v_date_value(p)));
    case 12: case 13: return collectionToJS(p, cell, kind === 12);
    case 6: return promiseToJS(p, cell);
    case 7: return errorToJS(p);
    default: return otherToJS(p, cell, 0);
    }
}

// The constructor CreateDynamicFunction uses for a function kind (JS_FUNCTION_KIND_*).
const HostGeneratorFunction = ReflectGetPrototypeOf(function* () {}).constructor;
const HostAsyncFunction = ReflectGetPrototypeOf(async function () {}).constructor;
const HostAsyncGeneratorFunction = ReflectGetPrototypeOf(async function* () {}).constructor;
function dynamicFunctionConstructor(kind) {
    return kind === 1 ? HostGeneratorFunction : kind === 2 ? HostAsyncFunction : kind === 3 ? HostAsyncGeneratorFunction : HostFunction;
}

// The runtime's ArrayBuffer or typed array as a V8 one holding a copy of the bytes.
function bufferToJS(p) {
    const mark = scratchTop;
    const info = slots(1);
    const kind = X.ganglion_v_buffer_info(p, info);
    views();
    const ptr = u32[info >>> 2];
    const length = u32[(info >>> 2) + 1];
    scratchTop = mark;
    const bytes = new BufferUint8Array(length);
    if (length > 0)
        Uint8ArrayPrototypeSet(bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + length));
    if (kind === 13)
        return TypedArrayBuffer(bytes);
    const Ctor = BUFFER_CTORS[kind - 1];
    return Ctor === null ? bytes : new Ctor(TypedArrayBuffer(bytes));
}

// The bytes of a page ArrayBuffer, typed array or DataView as [kind, Uint8Array] (kind as ganglion_v_buffer_create
// takes it), or null when the value is none of those.
function pageBytes(value) {
    if (ArrayBufferIsView(value)) {
        const tag = TypedArrayTag(value);
        if (tag === undefined)
            return [1, new BufferUint8Array(DataViewBuffer(value), DataViewByteOffset(value), DataViewByteLength(value))];
        const k = BUFFER_KIND_BY_NAME[tag];
        if (k === undefined)
            return null;
        return [k + 1, new BufferUint8Array(TypedArrayBuffer(value), TypedArrayByteOffset(value), TypedArrayByteLength(value))];
    }
    let length;
    try {
        length = ArrayBufferByteLength(value);
    } catch {
        return null;
    }
    return [13, new BufferUint8Array(value, 0, length)];
}

// Buffers the page passes into an engine call are copies, but the engine's functions may fill them in place
// (crypto.getRandomValues, TextEncoder.encodeInto, stream readers) and return the same object. While a call is
// being made `bufferPins` lists the copies; afterwards their bytes are written back to the page's buffers and a
// result that is one of the copies is the page's own object again.
let bufferPins = null;
function finishPins(pins, resultSlot) {
    let identical;
    for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        const mark = scratchTop;
        const info = slots(1);
        X.ganglion_v_buffer_info(pin.slot, info);
        views();
        const ptr = u32[info >>> 2];
        const length = u32[(info >>> 2) + 1];
        scratchTop = mark;
        if (length === pin.bytes.length && length > 0)
            Uint8ArrayPrototypeSet(pin.bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + length));
        views();
        if (u32[pin.slot >>> 2] === u32[resultSlot >>> 2] && (u32[(pin.slot >>> 2) + 1] >>> 0) === HI_OBJECT && (u32[(resultSlot >>> 2) + 1] >>> 0) === HI_OBJECT)
            identical = pin.page;
    }
    return identical;
}

function writeBuffer(p, kind, bytes) {
    const length = bytes.length;
    // A buffer the engine's memory cannot hold is a RangeError (as V8's for an allocation it cannot make), not a trap.
    const ptr = X.ganglion_alloc(length + 1);
    if (!ptr)
        throw new HostRangeError('Array buffer allocation failed');
    views();
    if (length > 0)
        Uint8ArrayPrototypeSet(TypedArrayPrototypeSubarray(u8, ptr, ptr + length), bytes);
    const made = X.ganglion_v_buffer_create(kind, ptr, length, p);
    X.ganglion_free(ptr);
    if (!made)
        throw new HostRangeError('Array buffer allocation failed');
}

// ImageData's pixels are the page's own array, as in Chrome: `imageData.data` is the same object on every read (the array the
// page constructed it with, or the first copy read out of the engine), and a page that writes into it is seen by the engine:
// the bytes are copied into the engine's buffer whenever the ImageData crosses into an engine call (putImageData,
// createImageBitmap, ...). Before, every read was a fresh copy, so `d.data[i] = v` never reached putImageData.
const imageDataPixels = new WeakMap(); // ImageData wrapper -> the page's typed array
function syncImageData(cell, pixels) {
    const mark = scratchTop;
    const r = slots(1), info = slots(1);
    try {
        if (rawGetInto(cell, keyBits('data'), r))
            return;
        views();
        if ((u32[(r >>> 2) + 1] >>> 0) !== HI_OBJECT)
            return;
        X.ganglion_v_buffer_info(r, info);
        views();
        const ptr = u32[info >>> 2];
        const length = u32[(info >>> 2) + 1];
        const page = new BufferUint8Array(TypedArrayBuffer(pixels), TypedArrayByteOffset(pixels), TypedArrayByteLength(pixels));
        if (length === page.length && length > 0)
            Uint8ArrayPrototypeSet(TypedArrayPrototypeSubarray(u8, ptr, ptr + length), page);
    } finally {
        scratchTop = mark;
    }
}

// A runtime object with no class of its own: an interface prototype (its mirror class's prototype),
// the language's own prototypes, or a plain object copied to a depth of two.
function otherToJS(p, cell, depth) {
    if (cell === objectPrototypeCell)
        return HostObject.prototype;
    const name = prototypeNameRaw(cell);
    if (name !== '') {
        const cls = classForPrototype(cell);
        if (cls !== null)
            return cls.prototype;
        const intrinsic = INTRINSIC_PARENTS[name];
        if (intrinsic !== undefined)
            return intrinsic.prototype;
    }
    return plainToJS(cell, depth);
}

// --- Values copied across whole: structured clone ----------------------------------------------------------------
// history.pushState(state), postMessage(message) and structuredClone(value) serialize the page's value in the engine, which walks the
// value as an engine object: a page's Array, Date or Map (foreign cells to it) came out as a bare `{}`. Those calls get a copy
// built in the engine instead: plain objects, arrays (holes kept), Dates and binary data, with cycles; anything else
// that is not cloneable in a browser either (functions, symbols, DOM nodes) throws DataCloneError, and Map, Set, RegExp, Error
// and boxed primitives, which are cloneable but not copied yet, throw it too rather than turn into `{}`.
const engineClones = new HostWeakSet();
const HostStructuredClone = globalThis.structuredClone;
const CLONED_FIRST_ARGUMENT = { __proto__: null, pushState: true, replaceState: true, postMessage: true, structuredClone: true };
// IndexedDB keys and values are converted in the engine too (convert a value to a key looks for an Array or a Date, and a stored
// value is structured-serialized): a page's [1, 2] or new Date() came out as a bare object, so indexedDB.cmp([1], [1]) and
// store.get(new Date()) threw "DataError: Value is invalid" (YouTube's unhandled rejection). The key and value arguments of
// these members are copied the same way; an engine object passed there (an IDBKeyRange as the query) goes as it is.
const IDB_QUERY = [0];
const CLONED_ARGUMENTS = { __proto__: null,
    'IDBFactory.cmp': [0, 1],
    'IDBKeyRange.only': [0], 'IDBKeyRange.lowerBound': [0], 'IDBKeyRange.upperBound': [0], 'IDBKeyRange.bound': [0, 1], 'IDBKeyRange.includes': [0],
    'IDBObjectStore.put': [0, 1], 'IDBObjectStore.add': [0, 1],
    'IDBObjectStore.get': IDB_QUERY, 'IDBObjectStore.getKey': IDB_QUERY, 'IDBObjectStore.getAll': IDB_QUERY, 'IDBObjectStore.getAllKeys': IDB_QUERY,
    'IDBObjectStore.delete': IDB_QUERY, 'IDBObjectStore.count': IDB_QUERY, 'IDBObjectStore.openCursor': IDB_QUERY, 'IDBObjectStore.openKeyCursor': IDB_QUERY,
    'IDBIndex.get': IDB_QUERY, 'IDBIndex.getKey': IDB_QUERY, 'IDBIndex.getAll': IDB_QUERY, 'IDBIndex.getAllKeys': IDB_QUERY,
    'IDBIndex.count': IDB_QUERY, 'IDBIndex.openCursor': IDB_QUERY, 'IDBIndex.openKeyCursor': IDB_QUERY,
    'IDBCursor.update': [0], 'IDBCursor.continue': [0], 'IDBCursor.continuePrimaryKey': [0, 1],
};
// args: the call's arguments when value is args[0] of a cloning member (its transfer list may move streams), else null.
function cloneForEngine(value, lenientCollections, args) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return value; // primitives go as they are
    const marker = { value, lenientCollections: lenientCollections === true, moves: args ? takeStreams(args) : null };
    WeakSetPrototypeAdd(engineClones, marker);
    return marker;
}
// Streams in the call's transfer list (postMessage(message, transfer | { transfer }), structuredClone(value, { transfer }); a
// Window's postMessage has the target origin before it). The engine cannot transfer a stream (its MessagePort transfer steps
// are missing), so each becomes a new stream of the page whose source is the old one (harness/segment/streams.js), and leaves
// the list the engine is given. The map goes to buildClone, which puts the new stream where the old one is in the message.
function takeStreams(args) {
    const bridge = callbacks.streams;
    if (!bridge || !bridge.bound)
        return null;
    let moves = null;
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object')
            continue;
        const direct = ArrayIsArray(a);
        let list;
        try {
            list = direct ? a : a.transfer;
            if (list === undefined || list === null || typeof list !== 'object')
                continue;
            list = ArrayFromList(list);
        } catch {
            continue; // not a sequence: the engine reports it
        }
        let any = false;
        for (let k = 0; k < list.length; k++)
            if (bridge.isStream(list[k]))
                any = true;
        if (!any)
            continue;
        if (moves === null)
            moves = new HostMap();
        const kept = [];
        for (let k = 0; k < list.length; k++) {
            if (!bridge.isStream(list[k]))
                ArrayPrototypePush(kept, list[k]);
            else if (!MapPrototypeHas(moves, list[k]))
                MapPrototypeSet(moves, list[k], bridge.mirror(list[k], 'page'));
        }
        if (direct) {
            args[i] = kept;
        } else {
            const options = ObjectCreate(null);
            const keys = ObjectKeys(a);
            for (let k = 0; k < keys.length; k++)
                options[keys[k]] = a[keys[k]];
            options.transfer = kept;
            args[i] = options;
        }
    }
    return moves;
}
// ArrayBuffers in the call's transfer list (the same places takeStreams looks). The engine is given a copy of each (page
// buffers are the host's), so the page's own buffer is detached here once the call has succeeded, as a transfer does in
// Chrome; one already detached, or listed twice, is the DataCloneError Chrome throws before anything is sent.
function transferredBuffers(args) {
    let out = null;
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object')
            continue;
        let list;
        try {
            list = ArrayIsArray(a) ? a : a.transfer;
            if (list === undefined || list === null || typeof list !== 'object')
                continue;
            list = ArrayFromList(list);
        } catch {
            continue;
        }
        for (let k = 0; k < list.length; k++) {
            const b = list[k];
            if (typeof b !== 'object' || b === null || !isArrayBuffer(b))
                continue;
            if (out === null)
                out = [];
            for (let j = 0; j < out.length; j++)
                if (out[j] === b)
                    throw new G.DOMException('ArrayBuffer at index ' + k + ' is a duplicate of an earlier ArrayBuffer. Duplicate transferable objects are not allowed.', 'DataCloneError');
            if (ArrayBufferDetached !== null && ArrayBufferDetached(b))
                throw new G.DOMException('An ArrayBuffer is detached and could not be cloned.', 'DataCloneError');
            ArrayPrototypePush(out, b);
        }
    }
    return out;
}
// An options object's `transfer` is read once, as Chrome's bindings convert the dictionary once: transferredBuffers, takeStreams
// and the engine each read it, so a getter could hand each a different list (secfuzz B3: the buffers checked and detached were
// not the ones the engine was given).
function snapshotTransfer(args) {
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object' || ArrayIsArray(a))
            continue;
        const transfer = a.transfer;
        const options = ObjectCreate(null);
        const keys = ObjectKeys(a);
        for (let k = 0; k < keys.length; k++)
            if (keys[k] !== 'transfer')
                options[keys[k]] = a[keys[k]];
        if (transfer !== undefined)
            options.transfer = transfer !== null && typeof transfer === 'object' ? ArrayFromList(transfer) : transfer;
        args[i] = options;
    }
}
function detachBuffers(list) {
    if (list === null || ArrayBufferTransfer === null)
        return;
    for (let i = 0; i < list.length; i++) {
        try {
            ArrayBufferTransfer(list[i]);
        } catch {}
    }
}
let activeMoves = null; // the stream moves of the clone being built
const STREAM_KEY = '\u0000chitin-stream:' + HostString(Math.random()).slice(2) + HostString(Math.random()).slice(2);
const inflightStreams = new HostMap(); // marker id -> the page stream a message in flight carries
let nextStreamId = 1;
// A value read back from the engine (a message's data, structuredClone's result) with its stream markers replaced by the streams.
function decodeStreams(value) {
    if (inflightStreams.size === 0 || (typeof value !== 'object' && typeof value !== 'function') || value === null || !callbacks.streams)
        return value;
    const isMarker = (x) => {
        try {
            return typeof x === 'object' && x !== null && ObjectHasOwn(x, STREAM_KEY) && typeof x[STREAM_KEY] === 'number';
        } catch {
            return false;
        }
    };
    if (!callbacks.streams.containsStream(value, isMarker))
        return value;
    const taken = [];
    const out = callbacks.streams.substitute(value, isMarker, (m) => {
        const id = m[STREAM_KEY];
        ArrayPrototypePush(taken, id);
        return MapPrototypeGet(inflightStreams, id);
    });
    for (let i = 0; i < taken.length; i++)
        MapPrototypeDelete(inflightStreams, taken[i]);
    return out;
}
// --- Types the engine's runtime does not have, carried as markers -------------------------------------------------
// The engine's JS runtime (engine/libjs-runtime) has no RegExp, BigInt, boxed primitives or DataView, and no typed array
// on part of a buffer, so a clone of those cannot be the engine's own object. Each goes through the engine's serializer as
// a plain object marked with CLONE_KEY (its fields engine values: strings, numbers, the ArrayBuffer a view is on) and
// readClone, which reads every structured clone result back, turns the marker into the type again. Errors go the same way
// (name, message and stack, as V8 clones them). The key is fixed, so a marker stored in IndexedDB reads back later too.
const CLONE_KEY = '\u0000chitin-clone';
const CloneRegExp = globalThis.RegExp;
const RegExpSource = uncurryThis(ObjectGetOwnPropertyDescriptor(CloneRegExp.prototype, 'source').get);
const RegExpFlags = uncurryThis(ObjectGetOwnPropertyDescriptor(CloneRegExp.prototype, 'flags').get);
const HostBoolean = globalThis.Boolean;
const BooleanValueOf = uncurryThis(HostBoolean.prototype.valueOf);
const NumberValueOf = uncurryThis(HostNumber.prototype.valueOf);
const StringValueOf = uncurryThis(HostString.prototype.valueOf);
const BigIntValueOf = uncurryThis(HostBigInt.prototype.valueOf);
const BigIntToString = uncurryThis(HostBigInt.prototype.toString);
const HostDataView = globalThis.DataView;
// The standard error names a clone keeps (HTML's serialization; anything else is "Error").
const CLONE_ERROR_NAMES = { __proto__: null, Error: HostError, EvalError: HostEvalError, RangeError: HostRangeError, ReferenceError: HostReferenceError, SyntaxError: HostSyntaxError, TypeError: HostTypeError, URIError: HostURIError };
// A marker object in `p`: { [CLONE_KEY]: kind, ...fields }, each field [name, page value] (cloned in turn, so a view's
// buffer is shared through `seen`).
function writeMarker(p, kind, fields, seen, depth) {
    const mark = scratchTop;
    const e = slots(1);
    X.ganglion_v_object_create(p);
    writeString(e, kind);
    X.ganglion_v_define_data(p, keyBits(CLONE_KEY), e);
    for (let i = 0; i < fields.length; i++) {
        buildClone(fields[i][1], e, seen, depth + 1);
        X.ganglion_v_define_data(p, keyBits(fields[i][0]), e);
    }
    scratchTop = mark;
}
// The primitive a boxed Boolean, Number, String or BigInt holds, as [primitive], or null.
function boxedValue(v) {
    try { return [BooleanValueOf(v)]; } catch {}
    try { return [NumberValueOf(v)]; } catch {}
    try { return [StringValueOf(v)]; } catch {}
    try { return [BigIntValueOf(v)]; } catch {}
    return null;
}
function isArrayBuffer(v) {
    try {
        ArrayBufferByteLength(v);
        return true;
    } catch {
        return false;
    }
}

// Engine interfaces with [Serializable] (LibWeb's IDL) or a transfer the engine does itself (MessagePort), by their toStringTag.
const ENGINE_SERIALIZABLE = { __proto__: null };
for (const n of ['MessagePort', 'Blob', 'File', 'FileList', 'CryptoKey', 'DOMException', 'QuotaExceededError', 'DOMMatrix', 'DOMMatrixReadOnly',
    'DOMPoint', 'DOMPointReadOnly', 'DOMQuad', 'DOMRect', 'DOMRectReadOnly', 'ImageBitmap', 'ImageData'])
    ENGINE_SERIALIZABLE['[object ' + n + ']'] = true;
function dataCloneError(what) {
    return new G.DOMException(what + ' could not be cloned.', 'DataCloneError');
}
// The engine object made for page object `v` (its cell: the slot it was written to is reused for the next sibling).
function rememberClone(seen, v, p) {
    views();
    MapPrototypeSet(seen, v, u32[p >>> 2]);
}
function buildClone(v, p, seen, depth) {
    if (typeof v !== 'object' && typeof v !== 'function' || v === null) {
        if (typeof v === 'function' || typeof v === 'symbol')
            throw dataCloneError(typeof v === 'function' ? String(v).slice(0, 40) : 'Symbol()');
        if (typeof v === 'bigint') {
            writeMarker(p, 'bigint', [['v', BigIntToString(v)]], seen, depth);
            return;
        }
        fromJS(v, p);
        return;
    }
    if (typeof v === 'function')
        throw dataCloneError(String(v).slice(0, 40));
    if (depth > 1000)
        throw dataCloneError('A value nested too deeply');
    const earlier = MapPrototypeGet(seen, v);
    if (earlier !== undefined) {
        writeObject(p, earlier);
        return;
    }
    if (activeMoves !== null) {
        const moved = MapPrototypeGet(activeMoves, v);
        if (moved !== undefined) {
            // The engine's serializer refuses a stream (a platform object that is not [Serializable]) and cannot move one (its
            // transfer steps trap), so the message carries a marker object; MessageEvent.data (50-frames.js) and the result of
            // structuredClone put the new stream where the marker is (decodeStreams).
            const id = nextStreamId++;
            MapPrototypeSet(inflightStreams, id, moved);
            const m = scratchTop;
            const e = slots(1);
            X.ganglion_v_object_create(p);
            fromJS(id, e);
            X.ganglion_v_define_data(p, keyBits(STREAM_KEY), e);
            scratchTop = m;
            return;
        }
    }
    const ownCell = WeakMapPrototypeGet(cellOf, v);
    if (ownCell !== undefined && ENGINE_SERIALIZABLE[ObjectPrototypeToString(v)] === true) {
        // A port goes to the engine as itself: its serializer moves it when the transfer list has it (patch 0029, in-process
        // entanglement) and throws DataCloneError when it does not, as Chrome does. The engine's [Serializable] platform objects
        // (geometry, Blob/File, ImageData, CryptoKey, DOMException) go as themselves too: its serializer copies them (HTML
        // StructuredSerializeInternal, the platform object steps), where a page object walk would refuse them.
        writeObject(p, ownCell);
        MapPrototypeSet(seen, v, p);
        return;
    }
    if (ownCell !== undefined || WeakMapPrototypeGet(handleOf, v) !== undefined && false || callbacks.streams && callbacks.streams.hostStream(v) !== null)
        throw dataCloneError('#<' + (v.constructor && v.constructor.name || 'Object') + '>');
    // Shared memory (a SharedArrayBuffer, a view on one, a shared WebAssembly.Memory): refused without cross-origin isolation and
    // for storage, as in Chrome. Isolated, the engine cannot hold it (its memory is not V8's), so the message carries a marker as
    // a stream does and the copy read back is the host's clone of it: a new object on the same memory, as Chrome's is.
    {
        let shared = isSharedArrayBuffer(v);
        if (!shared && ArrayBufferIsView(v)) {
            const tag = TypedArrayTag(v);
            shared = isSharedArrayBuffer(tag === undefined ? DataViewBuffer(v) : TypedArrayBuffer(v));
        }
        if (!shared && HostWasmMemory !== null && v instanceof HostWasmMemory) {
            try { shared = isSharedArrayBuffer(v.buffer); } catch { shared = false; }
        }
        if (shared) {
            if (!pageIsolated)
                throw sharedCloneError();
            if (seen.lenientCollections === true || !callbacks.streams)
                throw dataCloneError('#<SharedArrayBuffer>');
            const id = nextStreamId++;
            MapPrototypeSet(inflightStreams, id, HostStructuredClone(v));
            const m = scratchTop;
            const e = slots(1);
            X.ganglion_v_object_create(p);
            fromJS(id, e);
            X.ganglion_v_define_data(p, keyBits(STREAM_KEY), e);
            scratchTop = m;
            rememberClone(seen, v, p);
            return;
        }
    }
    // Binary data. In an IndexedDB key or value (lenientCollections) a view's own bytes are copied as before (a key must be
    // the engine's binary). Elsewhere an ArrayBuffer is copied once per clone, and a typed array or DataView is a marker over
    // that copy with its offset and length, as Chrome keeps them (two views of one buffer share one copy).
    if (seen.lenientCollections === true) {
        const bytes = pageBytes(v);
        if (bytes !== null) {
            writeBuffer(p, bytes[0], bytes[1]);
            return;
        }
    } else if (ArrayBufferIsView(v)) {
        const tag = TypedArrayTag(v);
        const isDataView = tag === undefined;
        writeMarker(p, 'view', [['type', isDataView ? 'DataView' : tag], ['buffer', isDataView ? DataViewBuffer(v) : TypedArrayBuffer(v)],
            ['offset', isDataView ? DataViewByteOffset(v) : TypedArrayByteOffset(v)], ['length', isDataView ? DataViewByteLength(v) : v.length]], seen, depth);
        rememberClone(seen, v, p);
        return;
    } else if (isArrayBuffer(v)) {
        writeBuffer(p, 13, new BufferUint8Array(v, 0, ArrayBufferByteLength(v)));
        rememberClone(seen, v, p);
        return;
    }
    const mark = scratchTop;
    const e = slots(1), r = slots(1);
    if (ArrayIsArray(v)) {
        const length = v.length >>> 0;
        X.ganglion_v_array_create(length, p);
        rememberClone(seen, v, p);
        if (length > 65536) {
            // A sparse array (new Array(2 ** 32 - 1) with one element) is walked by its own keys, as Chrome's serializer does:
            // a loop over the length hung the segment for minutes (secfuzz B1). Own keys list integer indices first, ascending.
            const keys = ReflectOwnKeys(v);
            for (let j = 0; j < keys.length; j++) {
                const key = keys[j];
                if (typeof key !== 'string')
                    continue;
                const i = +key;
                if (!(i >= 0 && i < length && i === (i >>> 0) && HostString(i) === key))
                    continue;
                buildClone(v[key], e, seen, depth + 1);
                X.ganglion_v_define_data(p, indexKey(i), e);
            }
            scratchTop = mark;
            return;
        }
        for (let i = 0; i < length; i++) {
            if (!ObjectHasOwn(v, i))
                continue;
            buildClone(v[i], e, seen, depth + 1);
            X.ganglion_v_define_data(p, indexKey(i), e);
        }
        scratchTop = mark;
        return;
    }
    let time;
    try { time = ReflectApply(DatePrototypeGetTime, v, []); } catch { time = undefined; }
    if (time !== undefined) {
        X.ganglion_v_date_create(time, p);
        scratchTop = mark;
        return;
    }
    const tag = ObjectPrototypeToString(v);
    if (tag === '[object Map]' || tag === '[object Set]') {
        // A Map or Set of the engine's, its entries copied in the page's order (the engine serializes it as Chrome does).
        const isMap = tag === '[object Map]';
        if (isMap)
            X.ganglion_v_map_create(p);
        else
            X.ganglion_v_set_create(p);
        rememberClone(seen, v, p);
        const k = slots(1);
        if (isMap) {
            const entries = ArrayFromList(MapPrototypeEntries(v));
            for (let i = 0; i < entries.length; i++) {
                buildClone(entries[i][0], k, seen, depth + 1);
                buildClone(entries[i][1], e, seen, depth + 1);
                X.ganglion_v_map_put(p, k, e);
            }
        } else {
            const values = ArrayFromList(SetPrototypeValues(v));
            for (let i = 0; i < values.length; i++) {
                buildClone(values[i], e, seen, depth + 1);
                X.ganglion_v_set_put(p, e);
            }
        }
        scratchTop = mark;
        return;
    }
    if (tag === '[object RegExp]') {
        writeMarker(p, 'regexp', [['source', RegExpSource(v)], ['flags', RegExpFlags(v)]], seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    const boxed = boxedValue(v);
    if (boxed !== null) {
        writeMarker(p, 'boxed', [['v', boxed[0]]], seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    if (tag === '[object Error]') {
        // HTML's serialization of an Error: the name when it is a standard one (else "Error"), the message when it is an own
        // data property; V8 keeps the stack too.
        let name = 'Error', stack;
        try {
            const n = v.name;
            if (typeof n === 'string' && CLONE_ERROR_NAMES[n] !== undefined)
                name = n;
        } catch {}
        const fields = [['name', name]];
        const md = ObjectGetOwnPropertyDescriptor(v, 'message');
        if (md !== undefined && 'value' in md)
            ArrayPrototypePush(fields, ['message', HostString(md.value)]);
        try {
            stack = v.stack;
        } catch {}
        if (typeof stack === 'string')
            ArrayPrototypePush(fields, ['stack', stack]);
        writeMarker(p, 'error', fields, seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    if (tag === '[object Promise]' || tag === '[object WeakMap]' || tag === '[object WeakSet]' || tag === '[object WeakRef]')
        throw dataCloneError('#<' + tag.slice(8, -1) + '>');
    X.ganglion_v_object_create(p);
    rememberClone(seen, v, p);
    const keys = ObjectKeys(v);
    for (let i = 0; i < keys.length; i++) {
        buildClone(v[keys[i]], e, seen, depth + 1);
        X.ganglion_v_define_data(p, keyBits(keys[i]), e);
    }
    scratchTop = mark;
}

function fromJS(value, p) {
    switch (typeof value) {
    case 'undefined': writeUndefined(p); return;
    case 'boolean': writeLoHi(p, value ? 1 : 0, HI_BOOLEAN); return;
    case 'number':
        if ((value | 0) === value && !(value === 0 && 1 / value < 0)) {
            writeLoHi(p, value >>> 0, HI_INT32);
        } else if (value !== value) {
            // NaN as the engine's one canonical NaN (0x7FF8000000000000): V8 keeps a NaN's payload and sign, and a NaN whose
            // top 16 bits are 0xFFF8 or above is a cell tag in the engine's NaN-boxing (a NaN from a Float64Array or a
            // DataView read was a bogus object pointer, anura.pro's IndexedDB put trapped on it; Chrome's `undefined * 1`
            // is 0xFFF8..., which made ToNumber recurse until the stack overflowed: setTimeout(f, NaN)).
            writeLoHi(p, 0, 0x7FF80000);
        } else {
            views();
            f64[p >>> 3] = value;
        }
        return;
    case 'string': writeString(p, value); return;
    case 'symbol': X.ganglion_key_value(keyBits(value), p); return;
    case 'bigint': throw typeError('BigInt values cannot be given to the engine yet');
    case 'object':
        if (value === null) {
            writeLoHi(p, 0, HI_NULL);
            return;
        }
        // fall through
    case 'function': {
        if (value === G) {
            writeObject(p, globalCell);
            return;
        }
        const errorCell = WeakMapPrototypeGet(moduleErrorCells, value);
        if (errorCell !== undefined) {
            writeObject(p, errorCell);
            return;
        }
        if (typeof value === 'object' && WeakSetPrototypeHas(engineClones, value)) {
            const outer = activeMoves;
            activeMoves = value.moves;
            try {
                const seen = new HostMap();
                seen.lenientCollections = value.lenientCollections;
                buildClone(value.value, p, seen, 0);
            } finally {
                activeMoves = outer;
            }
            return;
        }
        const cell = WeakMapPrototypeGet(cellOf, value);
        if (cell !== undefined) {
            const pixels = WeakMapPrototypeGet(imageDataPixels, value);
            if (pixels !== undefined)
                syncImageData(cell, pixels);
            writeObject(p, cell);
            return;
        }
        if (typeof value === 'object' && WeakMapPrototypeGet(handleOf, value) === undefined) {
            const binary = pageBytes(value);
            if (binary !== null) {
                writeBuffer(p, binary[0], binary[1]);
                if (bufferPins !== null)
                    ArrayPrototypePush(bufferPins, { page: value, bytes: binary[1], slot: p });
                return;
            }
        }
        const h = handleFor(value);
        let fcell = foreignCellByHandle[h];
        if (fcell === undefined) {
            if (typeof value === 'function')
                X.ganglion_foreign_function(h, isConstructorFunction(value) ? 1 : 0, p);
            else
                X.ganglion_foreign_object(h, p);
            views();
            foreignCellByHandle[h] = u32[p >>> 2];
            return;
        }
        writeObject(p, fcell);
        return;
    }
    }
}
function isConstructorFunction(f) {
    // Arrow functions and methods are not constructors; everything else may be.
    try {
        ReflectConstruct(HostString, [], f);
        return true;
    } catch {
        return false;
    }
}

// --- Reading the runtime's objects ------------------------------------------------------------------------------
function cellToJS(cell) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    const v = toJS(p);
    scratchTop = mark;
    return v;
}
function vGet(cell, key) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    const threw = X.ganglion_v_get(o, keyBits(key), r);
    const v = toJS(r);
    scratchTop = mark;
    if (threw)
        throw mapThrown(v);
    return v;
}
function vSet(cell, key, value) {
    const entered = idleEntry();
    try {
        return vSetEntered(cell, key, value);
    } catch (e) {
        engineTrapped(e, 'a property set from page code');
        throw e;
    } finally {
        idleExit(entered);
    }
}
function vSetEntered(cell, key, value) {
    const mark = scratchTop;
    const o = slots(1), val = slots(1), r = slots(1);
    writeObject(o, cell);
    fromJS(value, val);
    const threw = X.ganglion_v_set(o, keyBits(key), val, r);
    const v = toJS(r);
    scratchTop = mark;
    if (threw)
        throw mapThrown(v);
    return v;
}
function vPrototypeCell(cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    X.ganglion_v_prototype(o, r);
    views();
    const hi = u32[(r >>> 2) + 1], lo = u32[r >>> 2];
    scratchTop = mark;
    return (hi >>> 16) === TAG_OBJECT ? lo : 0;
}
function vOwnKeys(cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    X.ganglion_v_own_keys(o, r);
    const n = X.ganglion_keys_count();
    const keys = safeArray();
    for (let i = 0; i < n; i++)
        keys[i] = X.ganglion_keys_at(i);
    scratchTop = mark;
    return keys;
}
// { kind: 1 data | 2 accessor | 3 pending | 4 exotic, flags, value, getterCell, setterCell } or null.
function vOwnProperty(cell, bits) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const kind = X.ganglion_v_own_kind(o, bits);
    if (kind === 0) {
        scratchTop = mark;
        return null;
    }
    if (kind === 3) {
        scratchTop = mark;
        return { __proto__: null, kind: 3 };
    }
    const flagsPtr = slots(1), value = slots(1), getter = slots(1), setter = slots(1);
    const threw = X.ganglion_v_own_property(o, bits, flagsPtr, value, getter, setter);
    views();
    const flags = u32[flagsPtr >>> 2];
    let result = null;
    if (!threw && (flags & PD_PRESENT)) {
        // Object values stay as cells (valueCell): converting them here would walk prototype <-> constructor
        // cycles for ever. Primitives are converted now.
        result = { __proto__: null, kind: (flags & (PD_HAS_GET | PD_HAS_SET)) ? 2 : 1, flags, value: undefined, valueCell: 0, getterCell: 0, setterCell: 0, getterIsObject: false, setterIsObject: false };
        if (flags & PD_HAS_VALUE) {
            if ((u32[(value >>> 2) + 1] >>> 16) === TAG_OBJECT)
                result.valueCell = u32[value >>> 2];
            else
                result.value = toJS(value);
        }
        if (flags & PD_HAS_GET)
            result.getterCell = u32[getter >>> 2], result.getterIsObject = (u32[(getter >>> 2) + 1] >>> 16) === TAG_OBJECT;
        if (flags & PD_HAS_SET)
            result.setterCell = u32[setter >>> 2], result.setterIsObject = (u32[(setter >>> 2) + 1] >>> 16) === TAG_OBJECT;
    }
    scratchTop = mark;
    return result;
}
function vObjectKind(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const k = X.ganglion_v_object_kind(o);
    scratchTop = mark;
    return k;
}
function vClassName(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const ptr = X.ganglion_v_class_name(o, scratchTop);
    views();
    const n = u32[scratchTop >>> 2];
    const name = bytesToString(ptr, n);
    scratchTop = mark;
    return name;
}
function vHostFlags(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const f = X.ganglion_v_host_flags(o);
    scratchTop = mark;
    return f;
}

// --- Calling into the engine ---------------------------------------------------------------------------------------
// Page JS the host starts by itself (a V8 promise job, a microtask) calls bindings with no engine frame under
// it, so no script execution context and no backup incumbent realm: LibWeb's incumbent_realm() then fails its
// VERIFY and the engine stops (Wikipedia's Codex/Vue on the first keystroke). Such a call is bracketed with
// the same enter/leave the harness's evalInPage uses. `hostDepth` counts the engine's own calls out into
// page JS (callbacks, scripts, handlers), under which a context already exists.
let hostDepth = 0;
// The incumbent of a call made from a host job (HTML: the realm of the calling script). A frame's classic scripts are compiled
// under their own URLs (55-realms.js runFrameScript records them here: URL -> the frame's global, or null when two realms ran
// scripts of that URL), so the innermost page frame of the stack names the calling realm; a URL no frame ran is the principal
// window's. Used where the incumbent is observable: Window.postMessage's `source` (a parent posting to its frame after an
// `await` is the parent, not the frame whose postMessage it called).
const scriptRealmByUrl = new HostMap();
const STACK_URL_RE = /\(?((?:https?|blob|data):[^\s)]*?):\d+:\d+\)?\s*$/;
function noteScriptRealm(filename, global) {
    const url = HostString(filename);
    if (!MapPrototypeHas(scriptRealmByUrl, url))
        MapPrototypeSet(scriptRealmByUrl, url, global);
    else if (MapPrototypeGet(scriptRealmByUrl, url) !== global)
        MapPrototypeSet(scriptRealmByUrl, url, null);
}
function callerRealmCell() {
    if (scriptRealmByUrl.size === 0)
        return undefined;
    const E = HostError;
    const saved = [E.prepareStackTrace, E.stackTraceLimit];
    let stack;
    try {
        E.prepareStackTrace = undefined;
        E.stackTraceLimit = 16;
        stack = HostString(new E().stack);
    } catch {
        return undefined;
    } finally {
        E.prepareStackTrace = saved[0];
        E.stackTraceLimit = saved[1];
    }
    const lines = StringPrototypeSplit(stack, '\n');
    for (let i = 1; i < lines.length; i++) {
        const m = RegExpPrototypeExec(STACK_URL_RE, lines[i]);
        if (m === null)
            continue;
        const url = m[1];
        if (StringPrototypeIncludes(url, '/chitin/'))
            continue; // the glue's own frames
        if (!MapPrototypeHas(scriptRealmByUrl, url))
            return globalCell;
        const global = MapPrototypeGet(scriptRealmByUrl, url);
        if (global === null)
            return undefined;
        const cell = WeakMapPrototypeGet(cellOf, global);
        return cell === undefined ? undefined : cell;
    }
    return undefined;
}
function idleEntry(realmCell, incumbentFromStack) {
    if (incumbentFromStack === true && hostDepth === 0 && frameRealmsOn) {
        const caller = callerRealmCell();
        if (caller !== undefined)
            realmCell = caller;
    }
    // Any call with a document to enter is bracketed, scripts run or not: the DevTools console (or a host
    // callback) calling the page's globals on a page with no script of its own is the same case.
    if (hostDepth !== 0 || !scriptingOn || !X.ganglion_js_can_enter())
        return false;
    // With frame realms, the realm the page's code acts in: the realm of the function it calls (a frame's own
    // `postMessage`, its stand-in's methods), or of the global a stand-in belongs to (`realmCell`). The page's code in
    // a host job (after an `await`) has no engine frame to say which realm it is; the callee's realm stands in for it.
    // Everything else, and pages without frames, enter the principal realm.
    if (frameRealmsOn && realmCell !== undefined && realmCell !== 0 && realmCell !== globalCell) {
        const mark = scratchTop;
        const o = slots(1);
        writeObject(o, realmCell);
        const realm = X.ganglion_js_realm_of(o);
        scratchTop = mark;
        X.ganglion_js_enter_realm(realm);
        return true;
    }
    X.ganglion_js_enter();
    return true;
}
function idleExit(entered) {
    if (!entered || stoppedReason !== null) // after a trap the engine is not called again (engineTrapped)
        return;
    // The page's code is still running on the host's stack: microtasks the engine queued during the call (a mutation observer
    // microtask) run from the host's microtask queue, after this code and in order with its promise jobs (Host.cpp).
    if (HostQueueMicrotask === null) {
        X.ganglion_js_leave();
        return;
    }
    if (X.ganglion_js_leave_deferring_microtasks() === 1 && !engineCheckpointQueued) {
        engineCheckpointQueued = true;
        HostQueueMicrotask(engineCheckpoint);
    }
}
let engineCheckpointQueued = false;
function engineCheckpoint() {
    engineCheckpointQueued = false;
    if (stoppedReason === null && hostDepth === 0)
        X.ganglion_microtask_checkpoint();
}
function invoke(fnCell, thisValue, args, incumbentFromStack) {
    if (stoppedReason !== null)
        throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
    const entered = idleEntry(fnCell, incumbentFromStack);
    try {
        return invokeEntered(fnCell, thisValue, args);
    } catch (e) {
        engineTrapped(e, 'a call from page code');
        throw e;
    } finally {
        idleExit(entered);
    }
}
let readAsClone = false; // the next invoke's result is a structured clone's copy: read whole (cloneToJS)
function invokeEntered(fnCell, thisValue, args) {
    const asClone = readAsClone;
    readAsClone = false;
    const mark = scratchTop;
    const n = args.length;
    const f = slots(1), t = slots(1), a = slots(n || 1), r = slots(1);
    writeObject(f, fnCell);
    const outerPins = bufferPins;
    const pins = bufferPins = [];
    let threw, result;
    try {
        fromJS(thisValue, t);
        for (let i = 0; i < n; i++)
            fromJS(args[i], a + i * 8);
        bufferPins = outerPins;
        threw = X.ganglion_js_invoke(f, t, a, n, r);
        const same = pins.length ? finishPins(pins, r) : undefined;
        result = same !== undefined ? same : asClone && !threw ? cloneToJS(r) : toJS(r);
    } finally {
        bufferPins = outerPins;
    }
    scratchTop = mark;
    if (threw) {
        // The engine refused the call because the cell is not a function: a wrapper that stands for a cell the engine no
        // longer has as a function (a diagnostic for the operator's console, once per page; Discord, 2026-10-22).
        if (!reportedNotAFunction && result && result.message === 'not a function' && hostConsoleError !== undefined) {
            reportedNotAFunction = true;
            hostConsoleError(hostConsole, '[chitin] engine call refused (not a function); page stack:', new HostError().stack);
        }
        throw mapThrown(result);
    }
    return result;
}
let reportedNotAFunction = false;
function constructCell(ctorCell, args, newTarget) {
    const entered = idleEntry(ctorCell);
    try {
        return constructCellEntered(ctorCell, args, newTarget);
    } catch (e) {
        engineTrapped(e, 'a construct from page code'); // new AudioContext() trapped in Thread::start (chess.com)
        throw e;
    } finally {
        idleExit(entered);
    }
}
function constructCellEntered(ctorCell, args, newTarget) {
    const mark = scratchTop;
    const n = args.length;
    const f = slots(1), a = slots(n || 1), r = slots(1);
    writeObject(f, ctorCell);
    const outerPins = bufferPins;
    bufferPins = [];
    let threw, result;
    try {
        for (let i = 0; i < n; i++)
            fromJS(args[i], a + i * 8);
        const pins = bufferPins;
        bufferPins = outerPins;
        // NewTarget: a page class that extends an interface (a custom element extending HTMLElement) constructs the interface's
        // object with its own constructor as NewTarget, which the engine looks up (custom element definitions) and takes the
        // prototype from.
        let nt = 0;
        if (newTarget !== undefined) {
            nt = slots(1);
            fromJS(newTarget, nt);
        }
        threw = X.ganglion_js_construct(f, a, n, nt, r);
        if (pins.length)
            finishPins(pins, r);
        result = toJS(r);
        if (!threw && n > 0 && ArrayBufferIsView(args[0]) && typeof result === 'object' && result !== null && vClassName(u32[r >>> 2]) === 'ImageData')
            WeakMapPrototypeSet(imageDataPixels, result, args[0]);
    } finally {
        bufferPins = outerPins;
    }
    scratchTop = mark;
    if (threw) {
        // Interfaces without a constructor: Chrome's message.
        if (result instanceof HostTypeError && /is not a constructor$/.test(result.message)) {
            const illegal = typeError('Illegal constructor');
            WeakSetPrototypeAdd(engineErrors, illegal);
            throw illegal;
        }
        throw mapThrown(result);
    }
    if (newTarget !== undefined && typeof result === 'object' && result !== null) {
        const proto = newTarget.prototype;
        if (typeof proto === 'object' && proto !== null && ObjectGetPrototypeOf(result) !== proto)
            ObjectSetPrototypeOf(result, proto);
    }
    return result;
}

// A thrown runtime value as the page should see it. Engine errors arrive already converted to V8
// errors by errorToJS; DOMExceptions are wrappers; foreign values are the page's own.
function mapThrown(value) {
    return value;
}

const ERROR_CONSTRUCTORS = [HostError, HostEvalError, HostError, HostRangeError, HostReferenceError, HostSyntaxError, HostTypeError, HostURIError, HostAggregateError || HostError, HostError];
const errorTwins = new HostMap(); // runtime error cell -> the page's own error it stands for
// The other way, for a module script's failure only (ganglion_host_js_run_module): the error its promise rejects with is given
// to the engine as the engine Error that stands for it, so the error event's message is the error's (LibWeb reads `message`
// without side effects, which a host object cannot answer).
const moduleErrorCells = new WeakMap(); // the page's error -> its runtime error cell
const ObjectPrototypeToString = uncurryThis(HostObject.prototype.toString);
// A page error given to the engine (a throw out of a callback or a script) becomes a runtime Error cell
// with the same kind and message, so LibWeb's exception reporting reads it as an error; the page gets
// its own object back when the engine rethrows it.
function errorFromJS(e, p) {
    let kind = 0;
    let ctor;
    try {
        ctor = e.constructor;
    } catch { /* a proxy or accessor that throws */ }
    if (ctor === HostTypeError) kind = 6;
    else if (ctor === HostRangeError) kind = 3;
    else if (ctor === HostSyntaxError) kind = 5;
    else if (ctor === HostReferenceError) kind = 4;
    else if (ctor === HostEvalError) kind = 1;
    else if (ctor === HostURIError) kind = 7;
    const info = describeThrown(e);
    // The runtime reports an error by its class and message. A DOMException, a subclass or a bare object has the
    // generic class, so its own name goes first (message alone read "[object ForeignObject]" in the owner's run). A
    // standard class keeps its message as it is: pages read it back (ErrorEvent.message, a rejection's reason).
    let message = info.message;
    if (kind === 0 && info.name !== 'Error')
        message = info.name + ': ' + message;
    // The host's stack goes to the engine log where the report line will be, once per thrown value.
    if (!WeakSetPrototypeHas(describedThrown, e)) {
        WeakSetPrototypeAdd(describedThrown, e);
        if (info.stack !== '')
            engineLog('ganglion: thrown by the host: ' + info.name + ': ' + info.message + '\n' + info.stack);
        else
            engineLog('ganglion: thrown by the host (no stack): ' + info.name + ': ' + info.message + ' ' + ObjectPrototypeToString(e) + ' keys ' + describeKeys(e) + '\n' + new HostError('where').stack);
    }
    const ptr = stringToEngine(message);
    X.ganglion_v_error_create(kind, ptr, message.length, p);
    X.ganglion_free(ptr);
    X.ganglion_v_root(p);
    views();
    MapPrototypeSet(errorTwins, u32[p >>> 2], e);
}
const describedThrown = new HostWeakSet();
function describeKeys(e) {
    try { return HostString(ObjectKeys(e).slice(0, 8)); } catch { return '?'; }
}
// What a thrown host value is, without running anything that can throw: its class name (DOMException, a subclass's
// name, or the Object.prototype.toString tag), message and stack when they are strings.
function describeThrown(e) {
    let name = '', message = '', stack = '';
    try {
        const n = e.name;
        if (typeof n === 'string' && n !== '') name = n;
    } catch { /* an accessor that throws */ }
    if (name === '') {
        try {
            const c = e.constructor;
            if (typeof c === 'function' && typeof c.name === 'string') name = c.name;
        } catch { /* as above */ }
    }
    if (name === '') name = ObjectPrototypeToString(e).slice(8, -1);
    try {
        const m = e.message;
        if (typeof m === 'string') message = m;
    } catch { /* as above */ }
    if (message === '') {
        try {
            const j = typeof e.toString === 'function' ? ReflectApply(e.toString, e, []) : '';
            if (typeof j === 'string' && j !== '[object Object]') message = j;
        } catch { /* as above */ }
    }
    try {
        const st = e.stack;
        if (typeof st === 'string') stack = st;
    } catch { /* as above */ }
    return { name, message, stack };
}
function errorToJS(p) {
    views();
    const cell = u32[p >>> 2];
    const twin = MapPrototypeGet(errorTwins, cell);
    if (twin !== undefined)
        return twin;
    const kind = X.ganglion_v_error_kind(p);
    // Reading the message may run LibWeb accessors that throw; that must not hide the error being converted.
    let message = '';
    try {
        const v = vGet(cell, 'message');
        if (typeof v === 'string')
            message = v;
    } catch (inner) {
        message = '[the error\'s message could not be read: ' + (inner && inner.message) + ']';
    }
    const Ctor = ERROR_CONSTRUCTORS[kind] || HostError;
    const error = new Ctor(message);
    WeakSetPrototypeAdd(engineErrors, error);
    return error;
}

// An engine Map or Set (an IndexedDB value read back): a page Map or Set with the entries converted.
function collectionToJS(p, cell, isMap) {
    const out = isMap ? new HostMap() : new HostSet();
    cacheWrapperValue(cell, out);
    const mark = scratchTop;
    const a = slots(1);
    X.ganglion_v_collection_entries(p, a);
    const flat = arrayToJS(a);
    scratchTop = mark;
    if (isMap) {
        for (let i = 0; i + 1 < flat.length; i += 2)
            MapPrototypeSet(out, flat[i], flat[i + 1]);
    } else {
        for (let i = 0; i < flat.length; i++)
            SetPrototypeAdd(out, flat[i]);
    }
    return out;
}

// --- Values read back whole: the result of a structured clone ----------------------------------------------------
// structuredClone's result, MessageEvent.data, history.state and IndexedDB's values are the engine's deserialized copy, a
// tree of its own objects. toJS would mirror a plain object as a snapshot cut at depth two; this reads the whole copy into
// page objects of the same types, cycles and shared references kept (Chrome's deserialization). Platform objects (a Blob,
// a MessagePort, an IDBDatabase) are the engine's wrappers as usual.
let lastCloneCell = 0; // the cell the last cloneToJS read (getters cache their result per receiver and cell)
function cloneToJS(p) {
    views();
    const hi = u32[(p >>> 2) + 1];
    lastCloneCell = (hi >>> 16) === TAG_OBJECT ? u32[p >>> 2] : 0;
    const out = readClone(p, new HostMap(), 0);
    return out;
}
function rawGetInto(cell, key, r) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const threw = X.ganglion_v_get(o, key, r);
    scratchTop = mark;
    return threw;
}
// A marker (writeMarker) as the page value it stands for, or undefined when it is not one.
function readMarker(cell, seen, depth, r) {
    const kind = vGet(cell, CLONE_KEY);
    const field = (name) => {
        rawGetInto(cell, keyBits(name), r);
        return readClone(r, seen, depth + 1);
    };
    switch (kind) {
    case 'bigint': return HostBigInt(field('v'));
    case 'regexp': return new CloneRegExp(field('source'), field('flags'));
    case 'boxed': return HostObject(field('v'));
    case 'view': {
        const type = field('type');
        const Ctor = type === 'DataView' ? HostDataView : BUFFER_CTORS[BUFFER_KIND_BY_NAME[type]];
        if (typeof Ctor !== 'function')
            return undefined;
        return new Ctor(field('buffer'), field('offset'), field('length'));
    }
    case 'error': {
        const Ctor = CLONE_ERROR_NAMES[field('name')] || HostError;
        const out = vOwnProperty(cell, keyBits('message')) !== null ? new Ctor(field('message')) : new Ctor();
        if (vOwnProperty(cell, keyBits('stack')) !== null)
            ObjectDefineProperty(out, 'stack', { value: field('stack'), writable: true, enumerable: false, configurable: true });
        return out;
    }
    }
    return undefined;
}
function readClone(p, seen, depth) {
    views();
    const lo = u32[p >>> 2];
    const tag = u32[(p >>> 2) + 1] >>> 16;
    if (tag !== TAG_OBJECT || depth > 2000)
        return toJS(p);
    const cell = lo;
    const earlier = MapPrototypeGet(seen, cell);
    if (earlier !== undefined)
        return earlier;
    if (MapPrototypeGet(wrapperByCell, cell) !== undefined || cell === globalCell)
        return toJS(p);
    const kind = X.ganglion_v_object_kind(p);
    const mark = scratchTop;
    const r = slots(1);
    try {
        if (kind === 5) {
            const out = [];
            MapPrototypeSet(seen, cell, out);
            const n = vGet(cell, 'length') >>> 0;
            out.length = n;
            if (n > 65536) {
                // Sparse: by own keys, not by length (secfuzz B1, as buildClone).
                const keys = vOwnKeys(cell);
                for (let k = 0; k < keys.length; k++) {
                    if (X.ganglion_key_kind(keys[k]) === 2)
                        continue;
                    const key = keyToJS(keys[k]);
                    if (typeof key === 'symbol')
                        continue;
                    const i = +key;
                    if (!(i >= 0 && i < n && i === (i >>> 0) && HostString(i) === HostString(key)))
                        continue;
                    rawGetInto(cell, indexKey(i), r); // the index key, not the own-keys string form
                    out[i] = readClone(r, seen, depth + 1);
                }
                return out;
            }
            for (let i = 0; i < n; i++) {
                const bits = indexKey(i);
                if (vOwnProperty(cell, bits) === null)
                    continue;
                rawGetInto(cell, bits, r);
                out[i] = readClone(r, seen, depth + 1);
            }
            return out;
        }
        if (kind === 12 || kind === 13) {
            const isMap = kind === 12;
            const out = isMap ? new HostMap() : new HostSet();
            MapPrototypeSet(seen, cell, out);
            const a = slots(1);
            X.ganglion_v_collection_entries(p, a);
            views();
            const arr = u32[a >>> 2];
            const n = vGet(arr, 'length') >>> 0;
            const k = slots(1);
            for (let i = 0; i < n; i += isMap ? 2 : 1) {
                rawGetInto(arr, indexKey(i), r);
                const first = readClone(r, seen, depth + 1);
                if (isMap) {
                    rawGetInto(arr, indexKey(i + 1), k);
                    MapPrototypeSet(out, first, readClone(k, seen, depth + 1));
                } else {
                    SetPrototypeAdd(out, first);
                }
            }
            return out;
        }
        if (kind === 7) {
            let name = '', message, stack;
            try { name = vGet(cell, 'name'); } catch {}
            const Ctor = CLONE_ERROR_NAMES[name] || HostError;
            const mp = vOwnProperty(cell, keyBits('message'));
            if (mp !== null)
                message = HostString(vGet(cell, 'message'));
            const out = message === undefined ? new Ctor() : new Ctor(message);
            if (vOwnProperty(cell, keyBits('stack')) !== null) {
                try { stack = vGet(cell, 'stack'); } catch {}
                if (typeof stack === 'string')
                    ObjectDefineProperty(out, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
            }
            MapPrototypeSet(seen, cell, out);
            return out;
        }
        if (kind === 10) {
            const info = slots(1);
            const bk = X.ganglion_v_buffer_info(p, info);
            let out;
            const Ctor = bk >= 1 && bk <= 12 ? BUFFER_CTORS[bk - 1] : null;
            if (Ctor !== null) {
                // A view: over the clone's copy of its buffer (shared with the other views of it), offset and length kept.
                // When the buffer reads back short (a view the engine made over a received message's bytes read its buffer as
                // empty: DayDream's Wisp frames arrived as empty Uint8Arrays), the view's own bytes are copied instead.
                rawGetInto(cell, keyBits('buffer'), r);
                const buffer = readClone(r, seen, depth + 1);
                const offset = vGet(cell, 'byteOffset') >>> 0, length = vGet(cell, 'length') >>> 0;
                const size = Ctor.BYTES_PER_ELEMENT || 1;
                const fits = ObjectPrototypeToString(buffer) === '[object ArrayBuffer]' && offset + length * size <= buffer.byteLength;
                out = fits ? new Ctor(buffer, offset, length) : bufferToJS(p);
            } else {
                out = bufferToJS(p);
            }
            MapPrototypeSet(seen, cell, out);
            return out;
        }
        if (kind !== 9)
            return toJS(p);
        const proto = vPrototypeCell(cell);
        if (proto === objectPrototypeCell && vOwnProperty(cell, keyBits(CLONE_KEY)) !== null) {
            const out = readMarker(cell, seen, depth, r);
            if (out !== undefined) {
                MapPrototypeSet(seen, cell, out);
                return out;
            }
        }
        if (proto === objectPrototypeCell) {
            const out = {};
            MapPrototypeSet(seen, cell, out);
            const keys = vOwnKeys(cell);
            for (let i = 0; i < keys.length; i++) {
                if (X.ganglion_key_kind(keys[i]) === 2)
                    continue;
                const prop = vOwnProperty(cell, keys[i]);
                if (!prop || prop.kind !== 1 || !(prop.flags & PD_ENUMERABLE))
                    continue;
                rawGetInto(cell, keys[i], r);
                out[keyToJS(keys[i])] = readClone(r, seen, depth + 1);
            }
            return out;
        }
        return toJS(p);
    } finally {
        scratchTop = mark;
    }
}

function arrayToJS(p) {
    views();
    const cell = u32[p >>> 2];
    const n = vGet(cell, 'length') >>> 0;
    const out = [];
    for (let i = 0; i < n; i++)
        out[i] = vGet(cell, HostString(i));
    return out;
}

function plainToJS(cell, depth) {
    const out = {};
    if (depth > 2)
        return out;
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        if (X.ganglion_key_kind(keys[i]) === 2)
            continue;
        const prop = vOwnProperty(cell, keys[i]);
        if (!prop || prop.kind !== 1 || !(prop.flags & PD_ENUMERABLE))
            continue;
        const key = keyToJS(keys[i]);
        if (prop.valueCell) {
            const cached = MapPrototypeGet(wrapperByCell, prop.valueCell);
            if (cached !== undefined) {
                out[key] = cached;
                continue;
            }
            const mark = scratchTop;
            const vp = slots(1);
            writeObject(vp, prop.valueCell);
            const kind = X.ganglion_v_object_kind(vp);
            out[key] = kind === 8 || kind === 9 ? otherToJS(vp, prop.valueCell, depth + 1) : toJS(vp);
            scratchTop = mark;
        } else {
            out[key] = prop.value;
        }
    }
    // The runtime's Map and Set iterators are plain objects with an own `next` (Misc.cpp); a snapshot of one is
    // iterable itself, as every built-in iterator is.
    if (typeof out.next === 'function' && out[SymbolIterator] === undefined)
        ObjectDefineProperty(out, SymbolIterator, { value: function () { return this; }, writable: true, enumerable: false, configurable: true });
    return out;
}

// A runtime promise as a V8 promise that follows it (the engine's `then`, with the page's resolvers as
// foreign functions).
function promiseToJS(p, cell) {
    const twin = new HostPromise_((resolve, reject) => {
        // The runtime's promises have no `then` property (bare prototype): attach to the cell directly.
        const mark = scratchTop;
        const pr = slots(1), f = slots(1), r = slots(1);
        writeObject(pr, cell);
        fromJS(resolve, f);
        fromJS(reject, r);
        X.ganglion_promise_then(pr, f, r);
        scratchTop = mark;
    });
    cacheWrapper(cell, twin);
    return twin;
}
// A placeholder wrapper for a runtime object that has no class (promises, plain objects) so it can be
// a `this`.
function cellWrapperFor(cell) {
    const existing = MapPrototypeGet(wrapperByCell, cell);
    if (existing !== undefined)
        return existing;
    const o = ObjectCreate(null);
    WeakMapPrototypeSet(cellOf, o, cell);
    return o;
}

// --- Functions of the runtime as page functions ------------------------------------------------------------------
// A legacy factory function (`Image`, `Audio`, `Option`): its `prototype` is another interface's, but it is not
// that interface's constructor (`new HTMLImageElement()` is illegal, `new Image()` is not).
function legacyFactory(cell, cls) {
    const cached = MapPrototypeGet(functionByCell, cell);
    if (cached !== undefined)
        return cached;
    const raw = vGet(cell, 'name');
    const fname = typeof raw === 'string' ? raw : '';
    const factory = {
        [fname]: function (...args) {
            if (new.target === undefined)
                throw typeError(`Failed to construct '${fname}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
            return constructCell(cell, args, undefined);
        },
    }[fname];
    ObjectDefineProperty(factory, 'prototype', { value: cls.prototype, writable: false, enumerable: false, configurable: false });
    WeakSetPrototypeAdd(nativeFunctions, factory);
    MapPrototypeSet(functionByCell, cell, factory);
    cacheWrapper(cell, factory);
    WeakMapPrototypeSet(cellOf, factory, cell);
    return factory;
}
// A legacy callback interface object (NodeFilter) has no prototype, only its constants: WebIDL defines them on the
// function as read-only, enumerable, non-configurable data properties (TreeWalker filters read NodeFilter.SHOW_*).
function defineCallbackInterfaceConstants(f, cell) {
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        const key = keyToJS(keys[i]);
        if (key === 'length' || key === 'name' || typeof key !== 'string')
            continue;
        const prop = vOwnProperty(cell, keys[i]);
        if (prop && prop.kind === 1 && !prop.valueCell && typeof prop.value === 'number' && !(prop.flags & (PD_WRITABLE | PD_CONFIGURABLE)))
            ObjectDefineProperty(f, key, { value: prop.value, writable: false, enumerable: (prop.flags & PD_ENUMERABLE) !== 0, configurable: false });
    }
}
function functionToJS(p, cell) {
    const cached = MapPrototypeGet(functionByCell, cell);
    if (cached !== undefined)
        return cached;
    // An interface object: a function whose `prototype` is an interface prototype (it carries a toStringTag).
    const protoProp = vOwnProperty(cell, keyBits('prototype'));
    if (protoProp && protoProp.kind === 1 && protoProp.valueCell) {
        const cls = classForPrototype(protoProp.valueCell);
        if (cls !== null) {
            if (ownValueCell(protoProp.valueCell, 'constructor') === cell)
                return cls;
            return legacyFactory(cell, cls);
        }
    }
    const name = vGet(cell, 'name');
    const length = vGet(cell, 'length');
    const f = makeNativeFunction(typeof name === 'string' ? name : '', cell, typeof length === 'number' ? length : 0, undefined);
    defineCallbackInterfaceConstants(f, cell);
    MapPrototypeSet(functionByCell, cell, f);
    cacheWrapper(cell, f);
    WeakMapPrototypeSet(cellOf, f, cell);
    return f;
}

// A page-visible function that calls the runtime function `cell`. `boundThis` fixes the receiver (the
// global's members); otherwise the caller's `this` is passed through. `owner` is the interface the member is on
// (for the messages Chrome's bindings give, 45-surface.js).
function makeNativeFunction(name, cell, length, boundThis, owner) {
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    const clones = CLONED_FIRST_ARGUMENT[name] === true;
    const windowPost = name === 'postMessage' && (owner === 'Window' || bound);
    const clonedArguments = owner !== undefined ? CLONED_ARGUMENTS[owner + '.' + name] : undefined;
    const f = {
        [name](...args) {
            if (globalMember && foreignReceiver(this, boundThis))
                return foreignGlobalCall(f, name);
            // A native called with no receiver (`const add = window.addEventListener; add(...)`, a bare call) gets the global
            // object, as V8's API functions do; EventTarget's methods then work on it.
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if (!bound && owner !== undefined && notWrapper(self))
                throw illegalInvocation(f);
            try {
                // Only postMessage and structuredClone take an options dictionary there: pushState/replaceState's third argument
                // is the URL (a URL object from SvelteKit's router), which a snapshot turned into a plain object ("Cannot convert
                // object to primitive value").
                if (clones && args.length > 1 && (name === 'postMessage' || name === 'structuredClone'))
                    snapshotTransfer(args);
                const buffers = clones && args.length > 1 ? transferredBuffers(args) : null;
                if (clones && args.length > 0)
                    args[0] = cloneForEngine(args[0], false, args);
                if (clonedArguments !== undefined) {
                    for (let i = 0; i < clonedArguments.length; i++) {
                        const k = clonedArguments[i];
                        if (k < args.length && WeakMapPrototypeGet(cellOf, args[k]) === undefined)
                            args[k] = cloneForEngine(args[k], true, null);
                    }
                }
                if (clones && name === 'structuredClone') {
                    readAsClone = true;
                    const result = decodeStreams(invoke(cell, self, args));
                    detachBuffers(buffers);
                    return result;
                }
                const result = invoke(cell, self, args, windowPost);
                detachBuffers(buffers);
                return result;
            } catch (e) {
                throw chromeError(e, f, 'method', owner, name, self, args);
            }
        },
    }[name];
    ObjectDefineProperty(f, 'length', { value: length, writable: false, enumerable: false, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, f);
    return f;
}
// Getters whose value is a structured clone's copy (read whole by cloneToJS; the same object on every read while the
// engine's value is the same, as in Chrome).
const CLONE_GETTERS = { __proto__: null, 'MessageEvent.data': true, 'History.state': true, 'PopStateEvent.state': true, 'IDBRequest.result': true, 'IDBCursorWithValue.value': true, 'IDBCursor.key': true, 'IDBCursor.primaryKey': true, 'Notification.data': true };
function makeGetter(name, cell, boundThis, owner) {
    // The accessor's runtime function is held by the page's accessor from now on: rooted, so a property the engine
    // replaces or deletes (a [Replaceable] global such as performance) does not leave the page calling a collected cell
    // ("TypeError: not a function" from get performance, Discord's react-spring loop, 2026-10-22).
    rootAccessorCell(cell);
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    if (owner !== undefined && CLONE_GETTERS[owner + '.' + name] === true)
        return makeCloneGetter(name, cell, boundThis, owner);
    const imageDataGetter = owner === 'ImageData' && name === 'data';
    const f = {
        get [name]() {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if ((globalMember && foreignReceiver(this, boundThis)) || (!bound && owner !== undefined && notWrapper(self))) {
                if (lenientThis(name))
                    return undefined;
                throw illegalInvocation(getter);
            }
            try {
                if (imageDataGetter) {
                    const known = WeakMapPrototypeGet(imageDataPixels, self);
                    if (known !== undefined)
                        return known;
                    const pixels = invoke(cell, self, []);
                    if (typeof pixels === 'object' && pixels !== null)
                        WeakMapPrototypeSet(imageDataPixels, self, pixels);
                    return pixels;
                }
                return invoke(cell, self, []);
            } catch (e) {
                throw chromeError(e, getter, 'get', owner, name, self, []);
            }
        },
    };
    const getter = ObjectGetOwnPropertyDescriptor(f, name).get;
    WeakSetPrototypeAdd(nativeFunctions, getter);
    return getter;
}
// A MessageEvent the page constructs carries its init's `data` itself, as in Chrome (`new MessageEvent('message', { data: u8 })
// .data === u8`): it is not a structured clone, and the engine's copy of a typed array or ArrayBuffer is not the page's (a
// Uint8Array came back empty: libcurl.js's Wisp client wraps every DATA packet so, and TLS over it failed with error 35).
const constructedMessageData = new WeakMap(); // event -> { value }
function rememberMessageData(event, init) {
    if (typeof event !== 'object' || event === null || init === undefined || init === null || typeof init !== 'object' && typeof init !== 'function')
        return;
    const data = init.data;
    WeakMapPrototypeSet(constructedMessageData, event, { value: data === undefined ? null : data });
}
function makeCloneGetter(name, cell, boundThis, owner) {
    const bound = boundThis !== undefined;
    const pageData = owner === 'MessageEvent' && name === 'data';
    const reads = new WeakMap(); // receiver -> { cell, value }
    const f = {
        get [name]() {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if (!bound && owner !== undefined && notWrapper(self))
                throw illegalInvocation(getter);
            if (pageData) {
                const constructed = WeakMapPrototypeGet(constructedMessageData, self);
                if (constructed !== undefined)
                    return constructed.value;
            }
            try {
                readAsClone = true;
                lastCloneCell = 0;
                const value = invoke(cell, self, []);
                const read = lastCloneCell;
                if (read === 0 || typeof self !== 'object' && typeof self !== 'function' || self === null)
                    return value;
                const earlier = WeakMapPrototypeGet(reads, self);
                if (earlier !== undefined && earlier.cell === read)
                    return earlier.value;
                WeakMapPrototypeSet(reads, self, { cell: read, value });
                return value;
            } catch (e) {
                throw chromeError(e, getter, 'get', owner, name, self, []);
            } finally {
                readAsClone = false;
            }
        },
    };
    const getter = ObjectGetOwnPropertyDescriptor(f, name).get;
    WeakSetPrototypeAdd(nativeFunctions, getter);
    return getter;
}
function makeSetter(name, cell, boundThis, owner) {
    // The accessor's runtime function is held by the page's accessor from now on: rooted, so a property the engine
    // replaces or deletes (a [Replaceable] global such as performance) does not leave the page calling a collected cell
    // ("TypeError: not a function" from get performance, Discord's react-spring loop, 2026-10-22).
    rootAccessorCell(cell);
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    const dateArgument = name === 'valueAsDate';
    const f = {
        set [name](value) {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if ((globalMember && foreignReceiver(this, boundThis)) || (!bound && owner !== undefined && notWrapper(self))) {
                if (lenientThis(name))
                    return;
                throw illegalInvocation(setter);
            }
            try {
                // valueAsDate takes a Date (WebIDL `object?`, checked for [[DateValue]] in the engine): the page's Date is a V8 object,
                // so it goes over as an engine Date with the same time value.
                invoke(cell, self, [dateArgument && value !== null && typeof value === 'object' && WeakMapPrototypeGet(cellOf, value) === undefined ? cloneForEngine(value, false, null) : value]);
            } catch (e) {
                throw chromeError(e, setter, 'set', owner, name, self, [value]);
            }
        },
    };
    const setter = ObjectGetOwnPropertyDescriptor(f, name).set;
    WeakSetPrototypeAdd(nativeFunctions, setter);
    return setter;
}

// --- Classes from the runtime's prototypes -------------------------------------------------------------------------
// The runtime's %IteratorPrototype% is the host's: an iterator the engine makes (URLSearchParams, Headers, FormData and the
// other iterable interfaces' keys(), values(), entries()) is iterable itself and has the host's iterator helpers.
const HostIterator = function Iterator() {};
HostIterator.prototype = ReflectGetPrototypeOf(ReflectGetPrototypeOf([][SymbolIterator]()));
const INTRINSIC_PARENTS = { __proto__: null, Error: HostError, Function: HostFunction, Array, Object: HostObject, Promise: HostPromise_, Iterator: HostIterator };

// The mirror class for a runtime prototype object, or null when the prototype is one of the
// language's own (Object.prototype and the like), whose V8 counterpart is used instead.
function classForPrototype(protoCell) {
    if (protoCell === 0 || protoCell === objectPrototypeCell)
        return null;
    const cached = MapPrototypeGet(classByProto, protoCell);
    if (cached !== undefined)
        return cached;
    if (foreignObjectOf(protoCell) !== undefined)
        return null; // the page's own prototype: not an interface
    const name = prototypeNameRaw(protoCell);
    if (name === '' || INTRINSIC_PARENTS[name] !== undefined)
        return null;
    const parentCell = vPrototypeCell(protoCell);
    const parentClass = classForPrototype(parentCell);
    let parentIntrinsic = null;
    if (parentClass === null && parentCell !== 0 && parentCell !== objectPrototypeCell) {
        const parentName = prototypeNameRaw(parentCell);
        parentIntrinsic = INTRINSIC_PARENTS[parentName] || null;
    }
    const ctorProp = vOwnProperty(protoCell, keyBits('constructor'));
    let ctorCell = 0;
    if (ctorProp && ctorProp.kind === 1) {
        // Read the constructor cell without materialising a wrapper for it.
        ctorCell = ownValueCell(protoCell, 'constructor');
    }
    const cls = makeClass(name, parentClass || parentIntrinsic, ctorCell);
    MapPrototypeSet(classByProto, protoCell, cls);
    if (!MapPrototypeHas(classByName, name))
        MapPrototypeSet(classByName, name, cls); // the principal realm's (a frame realm's classes come later)
    WeakMapPrototypeSet(cellOf, cls.prototype, protoCell);
    cacheWrapper(protoCell, cls.prototype);
    if (ctorCell) {
        WeakMapPrototypeSet(cellOf, cls, ctorCell);
        cacheWrapper(ctorCell, cls);
        MapPrototypeSet(functionByCell, ctorCell, cls);
    }
    defineMembers(cls.prototype, protoCell, undefined, true);
    if (ctorCell)
        defineMembers(cls, ctorCell, cls, false);
    shapeClass(name, cls);
    return cls;
}
// The toStringTag of a prototype read without converting other values.
function prototypeNameRaw(protoCell) {
    const tag = vOwnProperty(protoCell, keyBits(SymbolToStringTag));
    if (tag && tag.kind === 1 && typeof tag.value === 'string')
        return tag.value;
    const ctorCell = ownValueCell(protoCell, 'constructor');
    if (ctorCell) {
        const name = vGet(ctorCell, 'name');
        if (typeof name === 'string')
            return name;
    }
    return '';
}
// The cell of an own data property whose value is an object, or 0.
function ownValueCell(cell, key) {
    const mark = scratchTop;
    const o = slots(1), flagsPtr = slots(1), value = slots(1), getter = slots(1), setter = slots(1);
    writeObject(o, cell);
    const bits = keyBits(key);
    const kind = X.ganglion_v_own_kind(o, bits);
    if (kind === 0 || kind === 3) {
        scratchTop = mark;
        return 0;
    }
    X.ganglion_v_own_property(o, bits, flagsPtr, value, getter, setter);
    views();
    const flags = u32[flagsPtr >>> 2];
    const result = (flags & PD_HAS_VALUE) && (u32[(value >>> 2) + 1] >>> 16) === TAG_OBJECT ? u32[value >>> 2] : 0;
    scratchTop = mark;
    return result;
}

function makeClass(name, Parent, ctorCell, prototypeObject) {
    // A plain function, not a class: Chrome's interface objects can be called (and then throw their own TypeError, not V8's
    // "Class constructors cannot be invoked without 'new'"), and `new.target` says which it was.
    const construct = (args, newTarget) => {
        if (!ctorCell)
            throw illegalConstructor(cls, true);
        try {
            const out = constructCell(ctorCell, args, newTarget === cls ? undefined : newTarget);
            if (name === 'MessageEvent')
                rememberMessageData(out, args[1]);
            return out;
        } catch (e) {
            throw chromeConstructError(e, cls, args);
        }
    };
    const cls = { [name]: function (...args) {
        if (new.target === undefined)
            throw callWithoutNew(cls, ctorCell !== 0 && constructible(cls));
        return construct(args, new.target);
    } }[name];
    if (prototypeObject !== undefined) {
        // An interface whose prototype object is one that already exists (45-surface.js adoptEventTargetPrototype).
        ObjectDefineProperty(cls, 'prototype', { value: prototypeObject });
        ObjectDefineProperty(prototypeObject, 'constructor', { value: cls, writable: true, enumerable: false, configurable: true });
    }
    if (Parent) {
        ObjectSetPrototypeOf(cls, Parent);
        ObjectSetPrototypeOf(cls.prototype, Parent.prototype);
    }
    ObjectDefineProperty(cls, 'prototype', { writable: false });
    WeakSetPrototypeAdd(nativeFunctions, cls);
    return cls;
}

// Defines the members of the runtime object `cell` on `target`: accessors, operations, constants.
// With `boundThis` the functions are bound to that receiver (the global's members on globalThis).
function defineMembers(target, cell, boundThis, isPrototype) {
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        const bits = keys[i];
        const key = keyToJS(bits);
        if (key === 'constructor' || (key === 'prototype' && !isPrototype) || (key === 'name' && !isPrototype))
            continue;
        if (key === 'length' && !isPrototype) {
            const lp = vOwnProperty(cell, bits);
            if (lp && lp.kind === 1)
                ObjectDefineProperty(target, 'length', { value: lp.value, writable: false, enumerable: false, configurable: true });
            continue;
        }
        defineMember(target, cell, bits, key, boundThis);
    }
}
// Value-iterable declarations (iterable<T>): WebIDL defines @@iterator, values, keys, entries and forEach on
// the prototype from %Array.prototype%'s functions, which the runtime does not carry; Chrome's are the same
// functions (NodeList.prototype.values === Array.prototype.values) except forEach, which is the interface's own.
const ArrayPrototypeForEach = uncurryThis(Array.prototype.forEach);
const ITERABLE_MEMBERS = { __proto__: null, values: Array.prototype.values, keys: Array.prototype.keys, entries: Array.prototype.entries };
function iterableMember(key) {
    if (key === SymbolIterator)
        return Array.prototype.values;
    if (key === 'forEach') {
        const f = { forEach(callback, thisArg) { ArrayPrototypeForEach(this, callback, thisArg); } }.forEach;
        ObjectDefineProperty(f, 'length', { value: 1, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        return f;
    }
    return ITERABLE_MEMBERS[key];
}

function defineMember(target, cell, bits, key, boundThis) {
    const prop = vOwnProperty(cell, bits);
    if (!prop)
        return;
    if (prop.kind === 1 && !prop.valueCell && prop.value === undefined && boundThis === undefined) {
        const fn = iterableMember(key);
        if (fn !== undefined) {
            ObjectDefineProperty(target, key, { value: fn, writable: true, enumerable: key !== SymbolIterator, configurable: true });
            return;
        }
    }
    if (prop.kind === 1 && !prop.valueCell && prop.value === undefined && typeof key === 'string' && !(boundThis === undefined && iterableMember(key) !== undefined)) {
        // A member the engine lists but does not implement (its value is undefined): absent, as in a browser without the feature,
        // so `'preserveAspectRatio' in element` is false instead of true-with-undefined (Chrome's is an accessor).
        return;
    }
    if (prop.kind === 3) {
        // A pending intrinsic (an interface object on the global): resolved on first touch.
        defineLazy(target, cell, key);
        return;
    }
    const enumerable = (prop.flags & PD_ENUMERABLE) !== 0;
    const configurable = (prop.flags & PD_CONFIGURABLE) !== 0;
    const owner = ownerName(cell);
    if (prop.kind === 2 && key === 'all' && owner === 'Document' && boundThis === undefined) {
        // document.all is an HTMLAllCollection with [[IsHTMLDDA]] in a browser: `!!document.all` is false and `typeof` is
        // 'undefined', which is how pages tell old IE from everything else (DuckDuckGo: `isIE = !!document.all`). Script
        // cannot make such an object. The getter answers null: falsy like Chrome's, `== null` and `== undefined` like
        // Chrome's, and unlike undefined it is not `===` to a missing value. polymer-resin (YouTube's sanitizer) passes a
        // falsy value through only when `value !== document.all`: with undefined every unset binding (`hidden` of the
        // search results among them) became its "zClosurez" placeholder, which is truthy, so the results stayed hidden.
        // Left different from Chrome: `typeof document.all` is 'object' (Chrome 'undefined') and `=== null` is true.
        const f = { get all() { return null; } };
        const getter = ObjectGetOwnPropertyDescriptor(f, 'all').get;
        WeakSetPrototypeAdd(nativeFunctions, getter);
        ObjectDefineProperty(target, key, { get: getter, set: undefined, enumerable, configurable });
        return;
    }
    if (prop.kind === 2) {
        const getter = prop.getterCell && prop.getterIsObject ? makeGetter(key, prop.getterCell, boundThis, owner) : undefined;
        const setter = prop.setterCell && prop.setterIsObject ? makeSetter(key, prop.setterCell, boundThis, owner) : undefined;
        ObjectDefineProperty(target, key, { get: getter, set: setter, enumerable, configurable });
        return;
    }
    const writable = (prop.flags & PD_WRITABLE) !== 0;
    const valueCell = prop.valueCell;
    if (valueCell && vObjectKind(valueCell) !== 4) {
        ObjectDefineProperty(target, key, { value: cellToJS(valueCell), writable, enumerable, configurable });
        return;
    }
    if (valueCell) {
        // An interface object (a constructor with an interface prototype) is its mirror class.
        const protoCell = ownValueCell(valueCell, 'prototype');
        if (protoCell && prototypeNameRaw(protoCell) !== '') {
            const cls = classForPrototype(protoCell);
            const value = cls === null ? cellToJS(valueCell) : ownValueCell(protoCell, 'constructor') === valueCell ? cls : legacyFactory(valueCell, cls);
            ObjectDefineProperty(target, key, { value, writable, enumerable, configurable });
            return;
        }
    }
    if (valueCell && vObjectKind(valueCell) === 4) {
        const length = vGet(valueCell, 'length');
        const fn = makeNativeFunction(typeof key === 'symbol' ? '[' + (key.description || '') + ']' : key, valueCell, typeof length === 'number' ? length : 0, boundThis, owner);
        if (boundThis === G && typeof key === 'string' && key.charCodeAt(0) >= 65 && key.charCodeAt(0) <= 90)
            defineCallbackInterfaceConstants(fn, valueCell);
        MapPrototypeSet(functionByCell, valueCell, fn);
        cacheWrapper(valueCell, fn);
        WeakMapPrototypeSet(cellOf, fn, valueCell);
        ObjectDefineProperty(target, key, { value: fn, writable, enumerable, configurable });
        return;
    }
    ObjectDefineProperty(target, key, { value: prop.value, writable, enumerable, configurable });
}
function defineLazy(target, cell, key) {
    ObjectDefineProperty(target, key, {
        get() {
            const value = vGet(cell, key);
            ObjectDefineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
            return value;
        },
        set(value) {
            ObjectDefineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
        },
        enumerable: false,
        configurable: true,
    });
}

// --- Wrapping a DOM object ------------------------------------------------------------------------------------------
// The page's own object a foreign cell stands for, or undefined for any other cell.
function foreignObjectOf(cell) {
    if (cell === 0)
        return undefined;
    const mark = scratchTop;
    const vp = slots(1);
    writeObject(vp, cell);
    const kind = X.ganglion_v_object_kind(vp);
    const out = kind === 2 || kind === 3 ? toJS(vp) : undefined;
    scratchTop = mark;
    return out;
}

function wrap(p, cell) {
    const protoCell = vPrototypeCell(cell);
    // The prototype is the page's when the engine took it from NewTarget (a custom element upgraded by a page class): the
    // wrapper inherits from the page's prototype, which inherits from the interface's mirror class.
    const pageProto = foreignObjectOf(protoCell);
    const cls = pageProto === undefined ? classForPrototype(protoCell) : null;
    let wrapper = pageProto !== undefined ? ObjectCreate(pageProto) : cls ? ObjectCreate(cls.prototype) : ObjectCreate(HostObject.prototype);
    WeakMapPrototypeSet(cellOf, wrapper, cell);
    // [LegacyUnforgeable] members are own properties of the runtime wrapper: mirror them.
    const own = vOwnKeys(cell);
    for (let i = 0; i < own.length; i++) {
        const key = keyToJS(own[i]);
        defineMember(wrapper, cell, own[i], key, undefined);
    }
    const flags = vHostFlags(cell);
    if (flags & 3)
        wrapper = exoticProxy(wrapper, cell, flags);
    cacheWrapper(cell, wrapper);
    return wrapper;
}

// Legacy platform objects with indexed or named properties: a Proxy whose traps ask the engine first.
function exoticProxy(target, cell, flags) {
    const indexed = (flags & 1) !== 0, named = (flags & 2) !== 0, unenumerable = (flags & 8) !== 0;
    const ownsKey = (key) => typeof key === 'string' && ((indexed && isArrayIndex(key)) || (named && !ReflectHas(target, key)));
    const proxy = new HostProxy(target, {
        get(t, key, receiver) {
            if (ownsKey(key)) {
                const v = vGet(cell, key);
                if (v !== undefined)
                    return v;
            }
            return ReflectGet(t, key, receiver);
        },
        has(t, key) {
            if (ownsKey(key) && vGet(cell, key) !== undefined)
                return true;
            return ReflectHas(t, key);
        },
        getOwnPropertyDescriptor(t, key) {
            if (ownsKey(key)) {
                const v = vGet(cell, key);
                if (v !== undefined)
                    return { value: v, writable: true, enumerable: typeof key === 'string' && isArrayIndex(key) ? true : !unenumerable, configurable: true };
            }
            return ObjectGetOwnPropertyDescriptor(t, key);
        },
        ownKeys(t) {
            const keys = vOwnKeys(cell);
            const out = [];
            for (let i = 0; i < keys.length; i++) {
                const k = keyToJS(keys[i]);
                if (typeof k === 'string' && ownsKey(k))
                    ArrayPrototypePush(out, k);
            }
            const rest = ReflectOwnKeys(t);
            for (let i = 0; i < rest.length; i++)
                ArrayPrototypePush(out, rest[i]);
            return out;
        },
        set(t, key, value, receiver) {
            if (ownsKey(key)) {
                try {
                    vSet(cell, key, value);
                    return true;
                } catch (e) {
                    throw e;
                }
            }
            return ReflectSet(t, key, value, receiver);
        },
        deleteProperty(t, key) {
            return ReflectDeleteProperty(t, key);
        },
    });
    WeakMapPrototypeSet(cellOf, proxy, cell);
    return proxy;
}

// --- The global ------------------------------------------------------------------------------------------------------
// A replacement of a member of the global (50-frames.js, 52-popups.js): a descriptor, or a function that is given a way to
// define the engine's own member on another object (to wrap it) and returns the descriptor.
function replacementFor(r, defineEngineMember) {
    return typeof r === 'function' ? r(defineEngineMember) : r;
}
function installGlobal() {
    const mark = scratchTop;
    const g = slots(1), op = slots(1);
    X.ganglion_js_global(g);
    X.ganglion_js_object_prototype(op);
    views();
    globalCell = u32[g >>> 2];
    objectPrototypeCell = u32[op >>> 2];
    scratchTop = mark;
    WeakMapPrototypeSet(cellOf, G, globalCell);
    MapPrototypeSet(wrapperByCell, globalCell, G);
    // The Window's members, from its prototype chain, as own properties of the realm's global.
    const chain = [];
    for (let proto = vPrototypeCell(globalCell); proto !== 0 && proto !== objectPrototypeCell; proto = vPrototypeCell(proto))
        ArrayPrototypePush(chain, proto);
    for (let i = chain.length - 1; i >= 0; i--) {
        const protoCell = chain[i];
        const keys = vOwnKeys(protoCell);
        for (let k = 0; k < keys.length; k++) {
            const key = keyToJS(keys[k]);
            if (key === 'constructor' || typeof key === 'symbol')
                continue;
            if (globalReplacements !== null && globalReplacements[key] !== undefined) {
                ObjectDefineProperty(G, key, replacementFor(globalReplacements[key], (target) => defineMember(target, protoCell, keys[k], key, G)));
                continue;
            }
            if (ObjectHasOwn(G, key) && !isWindowMemberWeWant(key))
                continue;
            defineMember(G, protoCell, keys[k], key, G);
        }
        // The prototype itself is an interface prototype (WindowPrototype, EventTargetPrototype): give it a class
        // so `EventTarget.prototype.addEventListener === window.addEventListener` is not required but `Window` exists.
        classForPrototype(protoCell);
    }
    // The global's own properties: [LegacyUnforgeable] accessors (window, document, location) and the
    // lazy interface objects.
    const own = vOwnKeys(globalCell);
    for (let k = 0; k < own.length; k++) {
        const key = keyToJS(own[k]);
        if (typeof key === 'symbol')
            continue;
        // A page's own Workers are not offered yet: the engine's Worker constructor needs the browser's worker
        // machinery, which it does not have (constructing one traps in MessagePort::transfer_steps). The names stay
        // undefined, as in a browser without workers, so a library that feature-detects (canvas-confetti, wasm
        // loaders) takes its main-thread path.
        if (key === 'Worker' || key === 'SharedWorker')
            continue;
        if (globalReplacements !== null && globalReplacements[key] !== undefined) {
            ObjectDefineProperty(G, key, replacementFor(globalReplacements[key], (target) => defineMember(target, globalCell, own[k], key, G)));
            continue;
        }
        if (ObjectHasOwn(G, key) && !isWindowMemberWeWant(key))
            continue;
        defineMember(G, globalCell, own[k], key, G);
    }
    installQueueMicrotask();
    installToString();
    installWasmStreaming();
    shapeSurface();
    snapshotGlobal();
}

// queueMicrotask joins the host's microtask queue, the one promise jobs run on. The engine's own queue ("queue a
// microtask" in LibWeb) is a second queue drained at other moments, so a library that mixes `await` and queueMicrotask
// (Svelte 5 flushes its batches from queueMicrotask and awaits tick()) saw the two out of order and a flush that never
// came. The spec has one queue; this is the nearest the host allows. An exception is reported, not thrown into the queue.
function installQueueMicrotask() {
    if (HostQueueMicrotask === null)
        return;
    const queue = {
        queueMicrotask(callback) {
            if (foreignReceiver(this, G))
                throw illegalInvocation(queue);
            if (typeof callback !== 'function')
                throw typeError("Failed to execute 'queueMicrotask' on 'Window': parameter 1 is not of type 'Function'.");
            HostQueueMicrotask(() => {
                try {
                    callback();
                } catch (e) {
                    try { G.reportError(e); } catch { /* nothing more to do with it */ }
                }
            });
        },
    }.queueMicrotask;
    WeakSetPrototypeAdd(nativeFunctions, queue);
    ObjectDefineProperty(G, 'queueMicrotask', { value: queue, writable: true, enumerable: true, configurable: true });
}

// The global as the mirror left it: every own property's descriptor, so a later document starts from it.
// Real browsers give each document a fresh realm; until M3's anchors bring one per navigation, the page's
// additions to the global (and its overwrites of the mirror's members) are undone by resetGlobal().
// Changes a page made deeper, on prototypes it shares with the next page, stay: a known gap.
const globalBaseline = new HostMap();
function snapshotGlobal() {
    MapPrototypeClear(globalBaseline);
    const keys = ReflectOwnKeys(G);
    for (let i = 0; i < keys.length; i++)
        MapPrototypeSet(globalBaseline, keys[i], ObjectGetOwnPropertyDescriptor(G, keys[i]));
}
function sameDescriptor(a, b) {
    return a.configurable === b.configurable && a.enumerable === b.enumerable && a.writable === b.writable
        && a.value === b.value && a.get === b.get && a.set === b.set;
}
function resetGlobal() {
    if (globalCell === 0)
        return;
    const keys = ReflectOwnKeys(G);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const now = ObjectGetOwnPropertyDescriptor(G, key);
        if (now === undefined)
            continue;
        const was = MapPrototypeGet(globalBaseline, key);
        if (was === undefined) {
            // The page's own global: a `var` from an indirect eval is configurable, as is an assignment.
            // A `var` or function of a real script is not configurable and cannot be deleted: the best a shared
            // realm can do is blank it (typeof says undefined; the name stays until the Worker is recycled).
            if (!ReflectDeleteProperty(G, key) && ObjectHasOwn(now, 'value') && now.writable)
                G[key] = undefined;
            continue;
        }
        if (sameDescriptor(now, was))
            continue;
        if (now.configurable)
            ReflectDefineProperty(G, key, was);
        else if (now.writable && ObjectHasOwn(was, 'value'))
            G[key] = was.value;
    }
}
// Worker globals that the Window's members replace (the Worker's own are hidden by the host script).
const WINDOW_OVERRIDES = { __proto__: null, self: true, location: true, navigator: true, performance: true, addEventListener: true, removeEventListener: true, dispatchEvent: true, setTimeout: true, clearTimeout: true, setInterval: true, clearInterval: true, queueMicrotask: true, requestAnimationFrame: true, cancelAnimationFrame: true, fetch: true, atob: true, btoa: true, structuredClone: true, reportError: true, crypto: true, caches: true, indexedDB: true, localStorage: true, sessionStorage: true, onerror: true, onunhandledrejection: true, name: true, origin: true, isSecureContext: true, crossOriginIsolated: true, scheduler: true, Image: true, Audio: true, Option: true };
const HOST_ONLY_GLOBALS = { __proto__: null, WebAssembly: true };
function isWindowMemberWeWant(key) {
    if (WINDOW_OVERRIDES[key] === true)
        return true;
    if (typeof key !== 'string' || key.length === 0)
        return false;
    const c = StringPrototypeCharCodeAt(key, 0);
    if (c < 65 || c > 90)
        return false;
    // An interface the engine defines is the page's interface even when the host global (a Worker in Chrome) has one
    // of that name: the engine's functions check their arguments against its own classes, so the host's Event is
    // not accepted by the engine's dispatchEvent ("Not an object of type Event"), and the engine's events are not
    // instanceof the host's. Only what is not an engine interface at all (WebAssembly) stays the host's.
    return !HOST_ONLY_GLOBALS[key] || !ObjectHasOwn(G, key);
}

// WebAssembly stays the host's (HOST_ONLY_GLOBALS), but the page's fetch() answers with the engine's Response, which the
// host's compileStreaming and instantiateStreaming refuse ("An argument must be provided, which must be a Response or
// Promise<Response> object": Discord's libdiscore). They take the page's Response here, with the checks of the WebAssembly
// Web API ("compile a potential WebAssembly response": the MIME type, an ok status, a body not used), and compile its bytes.
function installWasmStreaming() {
    const W = G.WebAssembly;
    const PageResponse = G.Response;
    if (W === undefined || typeof PageResponse !== 'function' || typeof W.compileStreaming !== 'function')
        return;
    const hostCompile = W.compile, hostInstantiate = W.instantiate, hostCompileStreaming = W.compileStreaming, hostInstantiateStreaming = W.instantiateStreaming;
    const lower = uncurryThis(HostString.prototype.toLowerCase), split = uncurryThis(HostString.prototype.split);
    const fail = (op, message) => new HostTypeError(`Failed to execute '${op}' on 'WebAssembly': ${message}`);
    async function bytesOf(op, source) {
        const response = await source;
        if (!(response instanceof PageResponse))
            return { host: response };
        const type = response.headers.get('content-type');
        if (type === null || lower(StringPrototypeTrim(split(type, ';')[0])) !== 'application/wasm')
            throw fail(op, "Incorrect response MIME type. Expected 'application/wasm'.");
        if (!response.ok)
            throw fail(op, 'HTTP status code is not ok');
        if (response.bodyUsed)
            throw fail(op, 'Cannot compile WebAssembly.Module from an already read Response');
        return { bytes: await response.arrayBuffer() };
    }
    const methods = {
        compileStreaming(source) {
            return (async () => {
                const got = await bytesOf('compile', source);
                return got.bytes === undefined ? ReflectApply(hostCompileStreaming, W, [got.host]) : ReflectApply(hostCompile, W, [got.bytes]);
            })();
        },
        instantiateStreaming(source, importObject) {
            return (async () => {
                const got = await bytesOf('instantiate', source);
                return got.bytes === undefined ? ReflectApply(hostInstantiateStreaming, W, [got.host, importObject]) : ReflectApply(hostInstantiate, W, [got.bytes, importObject]);
            })();
        },
    };
    for (const name of ['compileStreaming', 'instantiateStreaming']) {
        const was = ObjectGetOwnPropertyDescriptor(W, name);
        WeakSetPrototypeAdd(nativeFunctions, methods[name]);
        ObjectDefineProperty(W, name, { value: methods[name], writable: was.writable, enumerable: was.enumerable, configurable: was.configurable });
    }
}

// Function.prototype.toString prints `[native code]` for everything the mirror made (phase2.md 2.6).
function installToString() {
    const toString = {
        toString() {
            if (typeof this === 'function' && WeakSetPrototypeHas(nativeFunctions, this))
                return 'function ' + this.name + '() { [native code] }';
            try {
                return ReflectApply(FunctionPrototypeToString, this, []);
            } catch (e) {
                // Chrome's stack starts at the caller (the native toString frame is the only one above it)
                throw withStackFrom(e, toString);
            }
        },
    }.toString;
    WeakSetPrototypeAdd(nativeFunctions, toString);
    ObjectDefineProperty(HostFunction.prototype, 'toString', { value: toString, writable: true, enumerable: false, configurable: true });
}

// --- The foreign hooks: the engine using the page's values ---------------------------------------------------------
function makeBridgeImports() {
    const env = { __proto__: null };
    // Anything thrown that is an object becomes an engine Error cell that stands for it (errorTwins gives the page its own
    // value back): an Error, a DOMException (its tag is not Error), an error with a changed toStringTag, a plain object.
    const isThrownObject = (v) => typeof v === 'object' && v !== null;
    const result = (threw, p, value) => {
        try {
            if (threw && isThrownObject(value))
                errorFromJS(value, p);
            else
                fromJS(value, p);
        } catch (e) {
            fromJS(e, p);
            return 1;
        }
        return threw;
    };
    env.ganglion_host_js_get = (h, key, receiver, out) => {
        hostJsTouched = 1;
        try {
            const r = toJS(receiver);
            return result(0, out, ReflectGet(handles[h], keyToJS(key), r));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_set = (h, key, value, receiver, ok, out) => {
        hostJsTouched = 1;
        try {
            const v = toJS(value), r = toJS(receiver);
            views();
            u32[ok >>> 2] = ReflectSet(handles[h], keyToJS(key), v, r) ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_has = (h, key, outFlag, out) => {
        hostJsTouched = 1;
        try {
            const v = ReflectHas(handles[h], keyToJS(key));
            views();
            u32[outFlag >>> 2] = v ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_delete = (h, key, outFlag, out) => {
        hostJsTouched = 1;
        try {
            const v = ReflectDeleteProperty(handles[h], keyToJS(key));
            views();
            u32[outFlag >>> 2] = v ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_own_keys = (h, out) => {
        try {
            const keys = ReflectOwnKeys(handles[h]);
            for (let i = 0; i < keys.length; i++)
                X.ganglion_keys_push(keyBits(keys[i]));
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_get_own_property = (h, key, flagsPtr, value, getter, setter) => {
        hostJsTouched = 1;
        try {
            const d = ObjectGetOwnPropertyDescriptor(handles[h], keyToJS(key));
            views();
            if (!d) {
                u32[flagsPtr >>> 2] = 0;
                return 0;
            }
            let flags = PD_PRESENT | PD_HAS_ENUMERABLE | PD_HAS_CONFIGURABLE | (d.enumerable ? PD_ENUMERABLE : 0) | (d.configurable ? PD_CONFIGURABLE : 0);
            if ('value' in d) {
                flags |= PD_HAS_VALUE | PD_HAS_WRITABLE | (d.writable ? PD_WRITABLE : 0);
                fromJS(d.value, value);
            } else {
                flags |= PD_HAS_GET | PD_HAS_SET;
                fromJS(d.get, getter);
                fromJS(d.set, setter);
            }
            views();
            u32[flagsPtr >>> 2] = flags;
            return 0;
        } catch (e) {
            fromJS(e, value);
            return 1;
        }
    };
    env.ganglion_host_js_define_own_property = (h, key, flags, value, getter, setter, ok, out) => {
        hostJsTouched = 1;
        try {
            const d = {};
            if (flags & PD_HAS_VALUE) d.value = toJS(value);
            if (flags & PD_HAS_GET) d.get = toJS(getter);
            if (flags & PD_HAS_SET) d.set = toJS(setter);
            if (flags & PD_HAS_WRITABLE) d.writable = (flags & PD_WRITABLE) !== 0;
            if (flags & PD_HAS_ENUMERABLE) d.enumerable = (flags & PD_ENUMERABLE) !== 0;
            if (flags & PD_HAS_CONFIGURABLE) d.configurable = (flags & PD_CONFIGURABLE) !== 0;
            const r = ReflectDefineProperty(handles[h], keyToJS(key), d);
            views();
            u32[ok >>> 2] = r ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_get_prototype_of = (h, out) => {
        try {
            return result(0, out, ReflectGetPrototypeOf(handles[h]));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_call = (h, thisPtr, argv, argc, out) => {
        hostJsTouched = 1;
        try {
            const args = [];
            for (let i = 0; i < argc; i++)
                args[i] = toJS(argv + i * 8);
            const thisValue = toJS(thisPtr);
            return result(0, out, ReflectApply(handles[h], thisValue, args));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_construct = (h, argv, argc, newTarget, out) => {
        hostJsTouched = 1;
        try {
            const args = [];
            for (let i = 0; i < argc; i++)
                args[i] = toJS(argv + i * 8);
            const target = toJS(newTarget);
            return result(0, out, ReflectConstruct(handles[h], args, typeof target === 'function' ? target : handles[h]));
        } catch (e) {
            return result(1, out, e);
        }
    };
    // The engine is about to parse a new document into the realm (Host.cpp load_document).
    env.ganglion_host_js_document_reset = () => {
        documentsReset++;
        resetGlobal();
        resetFrameRealms();
        if (typeof callbacks.documentReset === 'function')
            callbacks.documentReset();
    };
    env.ganglion_host_js_drop = (h) => {
        const value = handles[h];
        if (value !== undefined) {
            WeakMapPrototypeDelete(handleOf, value);
            handles[h] = undefined;
            foreignCellByHandle[h] = undefined;
            ArrayPrototypePush(freeHandles, h);
        }
    };
    env.ganglion_host_js_run_script = (src, len, ascii, fname, flen, fascii, lineOffset, out) => {
        hostJsTouched = 1;
        const source = readText(src, len, ascii);
        const filename = readText(fname, flen, fascii);
        scriptsRun++;
        syncNamedProperties();
        try {
            // A classic script is a Script, not an eval: top-level let/const/class are shared by all of
            // the page's scripts, vars are not configurable, and there is no eval frame in a stack
            // (docs/security.md 4.1). The host that can run scripts for real provides options.runScript
            // (the Worker: importScripts through the service worker; Node: vm.Script); without one the
            // glue falls back to indirect eval.
            let value;
            const frameRealm = frameRealmOfCurrentScript();
            if (frameRealm !== null) {
                // A same-site frame's script: against the frame's global (55-realms.js).
                value = runFrameScript(frameRealm, '\n'.repeat(lineOffset > 1 ? lineOffset - 1 : 0) + source, filename);
                return result(0, out, value);
            }
            if (typeof callbacks.runScript !== 'function') {
                value = indirectEval(source + '\n//# sourceURL=' + filename);
            } else {
                try {
                    value = callbacks.runScript(source, filename, lineOffset);
                } catch (e) {
                    // A realm cannot forget its global lexical declarations: after a navigation the previous
                    // document's top-level let/const/class are still there. Until the host recycles the
                    // realm per document, a script that collides with one of them runs as an eval (its
                    // lexicals private to it) instead of failing the new page. Only after a reset: within one
                    // document a redeclaration is the page's own error, as in Chrome.
                    if (documentsReset > 1 && e && e.name === 'SyntaxError' && /has already been declared/.test(e.message))
                        value = indirectEval(source + '\n//# sourceURL=' + filename);
                    else
                        throw e;
                }
            }
            if (callbacks.scriptRun)
                callbacks.scriptRun(filename, source.length, indirectEval('this') === G, typeof G.qs, typeof G.app);
            syncFrameIndices();
            syncNamedProperties();
            return result(0, out, value);
        } catch (e) {
            if (callbacks.scriptError)
                callbacks.scriptError(filename, e);
            return result(1, out, e);
        }
    };
    // A module script (<script type=module>): the host's engine loads it and its imports itself (the module loader of
    // the segment's service worker, docs/phase2.md 2.3), so the engine's record has no requested modules and
    // Evaluate settles with the promise the host returns. An external module keeps its URL; an inline one has the
    // document's, which the host cannot import twice, so it gets a query naming it (relative imports still resolve
    // against the document's path).
    let inlineModules = 0;
    let moduleQueue = HostPromise_.resolve();
    const moduleFailed = (e) => {
        if (typeof e === 'object' && e !== null && WeakMapPrototypeGet(moduleErrorCells, e) === undefined) {
            const mark = scratchTop;
            const p = slots(1);
            try {
                errorFromJS(e, p);
                views();
                WeakMapPrototypeSet(moduleErrorCells, e, u32[p >>> 2]);
            } catch { /* left as it was */ }
            scratchTop = mark;
        }
        throw e;
    };
    const noop = () => {};
    env.ganglion_host_js_run_module = (src, len, ascii, fname, flen, fascii, lineOffset, out) => {
        hostJsTouched = 1;
        const source = readText(src, len, ascii);
        let filename = readText(fname, flen, fascii);
        scriptsRun++;
        try {
            if (typeof callbacks.runModule !== 'function')
                throw new HostTypeError('Module scripts are not available in this host');
            const frameRealm = frameRealmOfCurrentScript();
            if (frameRealm !== null) {
                // A same-site frame's module: its own module graph, under the realm's name (55-realms.js). In order, as below.
                const startFrame = () => runFrameModule(frameRealm, source, filename, lineOffset);
                const frameValue = PromisePrototypeThen(PromisePrototypeThen(moduleQueue, startFrame, startFrame), undefined, moduleFailed);
                moduleQueue = PromisePrototypeThen(frameValue, noop, noop);
                return result(0, out, frameValue);
            }
            let documentUrl = '';
            try { documentUrl = String(indirectEval('location.href')).replace(/#.*$/, ''); } catch (e) { documentUrl = ''; }
            if (filename.replace(/#.*$/, '') === documentUrl)
                filename = documentUrl + (documentUrl.includes('?') ? '&' : '?') + '__chitin_module=' + (++inlineModules);
            // Module scripts run one after the other, in the order the engine asks (document order: LibWeb runs them
            // in order, but the host's import settles on its own time). The next starts when the last has settled.
            const start = () => {
                if (callbacks.scriptRun)
                    callbacks.scriptRun(filename, source.length, true, typeof G.qs, typeof G.app);
                return callbacks.runModule(source, filename, lineOffset);
            };
            const value = PromisePrototypeThen(PromisePrototypeThen(moduleQueue, start, start), undefined, moduleFailed);
            moduleQueue = PromisePrototypeThen(value, noop, noop);
            return result(0, out, value);
        } catch (e) {
            if (callbacks.scriptError)
                callbacks.scriptError(filename, e);
            return result(1, out, e);
        }
    };
    // Functions from source text: an event handler's content attribute (EventTarget.cpp, "get the current value of the
    // event handler"). The engine checks the parameters and the body when it first needs the handler (the parser's early
    // errors; the function is built and dropped), and asks for the function when it has the scope: the element, its form
    // owner and the document as with-statements around the function's source, the way the specification's
    // NewObjectEnvironment(…, true, …) scopes work. The function keeps its source text (toString), its name and its
    // sloppy-mode body; the global scope is the page's global, the realm's.
    env.ganglion_host_js_check_function = (paramsPtr, paramsLen, paramsAscii, bodyPtr, bodyLen, bodyAscii, kind, out) => {
        const parameters = readText(paramsPtr, paramsLen, paramsAscii);
        const body = readText(bodyPtr, bodyLen, bodyAscii);
        try {
            dynamicFunctionConstructor(kind)(parameters, body);
            return 0;
        } catch (e) {
            return result(1, out, HostString(e && e.message !== undefined ? e.message : e));
        }
    };
    env.ganglion_host_js_instantiate_function = (srcPtr, srcLen, srcAscii, paramsPtr, paramsLen, paramsAscii, bodyPtr, bodyLen, bodyAscii, kind, scopesPtr, scopeCount, noop, out) => {
        try {
            if (noop)
                return result(0, out, function () {});
            const source = readText(srcPtr, srcLen, srcAscii);
            // A frame realm's handler: the realm's global object comes last (Bridge.cpp); the scopes are inside the frame's.
            let frameRealm = null;
            if (frameRealmsOn && scopeCount > 0) {
                views();
                frameRealm = frameRealmOfGlobalCell(u32[(scopesPtr + (scopeCount - 1) * 8) >>> 2]);
                if (frameRealm !== null)
                    scopeCount--;
            }
            const scopes = [];
            for (let i = 0; i < scopeCount; i++)
                scopes[i] = toJS(scopesPtr + i * 8);
            if (frameRealm !== null)
                return result(0, out, frameHandlerFactory(frameRealm, scopeCount, source)(frameRealm.runtime, scopes));
            // Innermost first in `scopes`: the innermost with-statement is the first.
            let code = '';
            for (let i = scopeCount - 1; i >= 0; i--)
                code += 'with (__chitin_scopes[' + i + ']) ';
            const factory = HostFunction('__chitin_scopes', code + 'return (' + source + '\n);');
            return result(0, out, factory(scopes));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_json_parse = (text, len, ascii, out) => {
        try {
            return result(0, out, JSONParse(readText(text, len, ascii)));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_json_stringify = (value, replacer, space, out) => {
        try {
            const s = JSONStringify(toJS(value), toJS(replacer), toJS(space));
            return result(0, out, s);
        } catch (e) {
            return result(1, out, e);
        }
    };
    // The engine calling out into page JS: a context exists under everything these run.
    for (const name of ['ganglion_host_js_get', 'ganglion_host_js_set', 'ganglion_host_js_has', 'ganglion_host_js_delete', 'ganglion_host_js_own_keys',
        'ganglion_host_js_get_own_property', 'ganglion_host_js_define_own_property', 'ganglion_host_js_get_prototype_of', 'ganglion_host_js_call',
        'ganglion_host_js_construct', 'ganglion_host_js_run_script', 'ganglion_host_js_run_module']) {
        const inner = env[name];
        env[name] = function () {
            hostDepth++;
            let r;
            try {
                r = ReflectApply(inner, undefined, arguments);
            } finally {
                hostDepth--;
            }
            // The engine stopped under this call (a trap or a stack overflow in a nested engine call, which the page's code
            // between saw as an exception it may catch): the engine's frames below are not resumed, so no microtask or
            // clean-up step runs on the broken state; the stop unwinds to the outermost call, which refuses from then on.
            if (unwoundError !== null)
                settleUnwound();
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            return r;
        };
    }
    return env;
}

// --- The API for the segment host ----------------------------------------------------------------------------------
// Page JavaScript from now on: the engine runs scripts through V8 in this realm, and the Window's
// surface appears on the global. After start().
api.enableScripting = () => {
    scratchInit();
    for (let i = 0; i < WELL_KNOWN.length; i++) {
        wellKnownSymbols[i] = HostSymbol[WELL_KNOWN[i]];
        wellKnownKeys[i] = X.ganglion_key_well_known(i);
    }
    X.ganglion_js_enable();
    prepareFrames();
    preparePopups();
    installGlobal();
    enableFrameRealms(callbacks.frameRealms === true);
    scriptingOn = true;
    installFrames();
    installPopups();
    if (callbacks.streams) {
        callbacks.streams.bind(G); // the page's stream classes, before page code can replace them
        callbacks.streams.setPump(() => api.pump()); // what the host settles for a stream is not an engine turn
    }
};

// Runs source in the page's realm (tests and the harness only; never reachable from page code), on a
// script-having execution context so bindings that need the incumbent realm work.
// The Window of the page's workers' environment for an origin (Host.cpp worker_environment_global): its indexedDB and
// IDBKeyRange serve the page's service worker and workers (harness/segment/pagesw-host.js). null when there is none.
api.workerEnvironment = (url) => {
    if (typeof X.ganglion_worker_environment !== 'function')
        return null;
    const text = HostString(url);
    const ptr = copyInString(text);
    const mark = scratchTop;
    const out = slots(1);
    let result = null;
    try {
        if (X.ganglion_worker_environment(ptr, TypedArrayLength(TextEncoderPrototypeEncode(encoderUtf8, text)), out))
            result = toJS(out);
    } finally {
        scratchTop = mark;
        X.ganglion_free(ptr);
    }
    return result;
};

api.evalInPage = (source) => {
    X.ganglion_js_enter();
    hostDepth++;
    try {
        return indirectEval(source);
    } finally {
        syncFrameIndices();
        syncNamedProperties();
        hostDepth--;
        X.ganglion_js_leave();
        api.pump();
    }
};

// The bytes of a URL fetched by the engine itself (its network stack over Spiracle: TLS, the cookie jar, CORS against the
// document's origin), for the segment's module loader: the service worker answers a module's imports with these. It is the
// engine's own `fetch` read from the engine's global, not the page's `window.fetch`: a page (a proxy, a polyfill) may have
// replaced that one, and the loader must not run page code. Resolves { status, contentType, body: ArrayBuffer }.
api.fetchBytes = async (url) => {
    const f = vGet(globalCell, 'fetch');
    const response = await ReflectApply(f, G, [HostString(url), { __proto__: null, credentials: 'same-origin', redirect: 'follow' }]);
    const body = await response.arrayBuffer();
    const type = response.headers.get('content-type');
    return { __proto__: null, status: response.status, contentType: typeof type === 'string' ? type : null, body };
};

// The names a frame realm's module binds in its prologue (harness/segment/sw.js asks, through the host, for each module of
// a frame's module graph): see 55-realms.js.
api.frameModuleBindings = (realmId, text) => frameModuleBindings(realmId, HostString(text));

// A function the segment host made for the page's surface (harness/segment/eme.js) prints as a native one, as the mirror's do.
api.markNative = (f) => {
    if (typeof f === 'function')
        WeakSetPrototypeAdd(nativeFunctions, f);
};

// Counters for the numbers.
api.mirrorStats = () => ({ __proto__: null, classes: classByProto.size, wrappers: wrapperByCell.size, handles: handles.length - freeHandles.length, scriptsRun });

// What the engine returns for a property of the global, before conversion (debugging).
api.mirrorProbe = (key) => {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, globalCell);
    const threw = X.ganglion_v_get(o, keyBits(key), r);
    views();
    const lo = u32[r >>> 2], hi = u32[(r >>> 2) + 1];
    const out = { __proto__: null, threw, lo, tag: (hi >>> 16).toString(16) };
    if ((hi >>> 16) === TAG_OBJECT) {
        out.kind = X.ganglion_v_object_kind(r);
        out.className = vClassName(lo);
        out.flags = vHostFlags(lo);
        out.cached = MapPrototypeGet(wrapperByCell, lo) === G ? 'G' : MapPrototypeGet(wrapperByCell, lo) !== undefined ? 'cached' : 'none';
    }
    scratchTop = mark;
    return out;
};

// What the mirror sees of the global (debugging the install).
api.mirrorDebug = () => {
    const out = { __proto__: null, globalCell, objectPrototypeCell, chain: [] };
    let proto = vPrototypeCell(globalCell);
    out.ownKeys = vOwnKeys(globalCell).length;
    out.ownKind = vObjectKind(globalCell);
    out.className = vClassName(globalCell);
    for (let i = 0; proto !== 0 && i < 8; i++) {
        const keys = vOwnKeys(proto);
        const names = [];
        for (let k = 0; k < MathMin(keys.length, 6); k++)
            ArrayPrototypePush(names, HostString(keyToJS(keys[k])));
        ArrayPrototypePush(out.chain, { __proto__: null, cell: proto, name: prototypeNameRaw(proto), keys: keys.length, sample: names });
        proto = vPrototypeCell(proto);
    }
    return out;
};

// ===== glue/engine/45-surface.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the surface (docs/surface.md). What a page can observe about its global that says "Worker" or "not Chrome":
// the messages and stacks of the errors bindings throw, interface objects that are called, the Window's own names and prototypes
// on a Worker's immutable-prototype global, main-thread-only behaviours (Atomics.wait throws, no SharedArrayBuffer without
// cross-origin isolation, dialogs that return at once), window.chrome. Each item has a check in tests/chrome/run.mjs that compares
// against Chrome's top-level window, and the diff (make surface-diff) counts what is left.

const ObjectDefineProperties = HostObject.defineProperties;
const SymbolAsyncIterator = HostSymbol.asyncIterator;
const PromiseReject = HostPromise_.reject.bind(HostPromise_);
const ErrorCaptureStackTrace = HostError.captureStackTrace;
const HostRegExp = globalThis.RegExp;
// RegExpPrototypeExec: 50-frames.js
const NOT_AN_OBJECT_OF_TYPE = new HostRegExp('^Not an object of type (\\w+)$');
const NEEDS_ARGUMENTS = new HostRegExp('^[\\w.]+\\(\\) needs (one|\\d+) arguments?$');
const NEEDS_AT_LEAST_ARGUMENTS = new HostRegExp('^[\\w.]+\\(\\) needs at least (one|\\d+) arguments?$');

// The stack of `e` as if it were thrown by the native function `fn`: the frames above and including `fn` (ours) are dropped, so it
// starts at the page's call site, as V8's own errors from native functions do.
function withStackFrom(e, fn) {
    if (ErrorCaptureStackTrace !== undefined && typeof e === 'object' && e !== null) {
        try {
            ErrorCaptureStackTrace(e, fn);
        } catch { /* a frozen error: it keeps its stack */ }
    }
    return e;
}
// The receiver of a member of the global that is not the global (nor the undefined/null that means "the global"): Chrome throws.
// (Only in a Worker: under Node's vm the global the page sees and the object the glue was handed are different objects.)
let checkGlobalReceivers = false; // set once the global is a Worker's (shapeWindowChain)
function foreignReceiver(self, global) {
    return checkGlobalReceivers && self !== global && self !== undefined && self !== null;
}
function illegalInvocation(fn) {
    return withStackFrom(new HostTypeError('Illegal invocation'), fn);
}
function illegalConstructor(fn, viaNew) {
    return withStackFrom(new HostTypeError(viaNew ? "Failed to construct '" + fn.name + "': Illegal constructor" : 'Illegal constructor'), fn);
}
function callWithoutNew(fn, constructible) {
    if (!constructible)
        return illegalConstructor(fn, false);
    return withStackFrom(new HostTypeError("Failed to construct '" + fn.name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."), fn);
}

// Members of the global that a Window does not check the receiver of (event-handler attributes), and those that return a promise:
// Chrome answers a foreign receiver there with a rejected promise, not a throw.
// (onmouseenter, onmouseleave and onreadystatechange are [LegacyLenientThis] in Chrome: a foreign receiver reads undefined and sets nothing.)
const LENIENT_GLOBAL_MEMBERS = /^on(mouseenter|mouseleave|readystatechange)$/;
const PROMISE_GLOBAL_MEMBERS = { __proto__: null, fetch: true, createImageBitmap: true, scroll: true, scrollBy: true, scrollTo: true };
function foreignGlobalCall(fn, name) {
    const error = illegalInvocation(fn);
    if (PROMISE_GLOBAL_MEMBERS[name] === true)
        return PromiseReject(error);
    throw error;
}
function lenientThis(name) {
    return LENIENT_GLOBAL_MEMBERS.test(name);
}
// A receiver that is not an engine object (or the global): Chrome checks it before it looks at the arguments.
function notWrapper(self) {
    return !((typeof self === 'object' || typeof self === 'function') && self !== null && WeakMapPrototypeGet(cellOf, self) !== undefined);
}

// The interface a member is on, for messages ("Failed to execute 'appendChild' on 'Node'").
const ownerNames = new HostMap();
function ownerName(cell) {
    let name = MapPrototypeGet(ownerNames, cell);
    if (name === undefined) {
        name = vObjectKind(cell) === 4 ? vGet(cell, 'name') : prototypeNameRaw(cell);
        if (typeof name !== 'string')
            name = '';
        if (name === 'WindowProperties' || name === 'WindowPrototype')
            name = 'Window';
        MapPrototypeSet(ownerNames, cell, name);
    }
    return name;
}

const QUERY_METHODS = { __proto__: null, querySelector: true, querySelectorAll: true, matches: true, closest: true, webkitMatchesSelector: true };

// What an engine error looks like when a binding throws it: Chrome's messages and a stack that starts at the caller. Anything that
// is not an error the engine made (a page's own throw coming back through a callback, a DOMException with Chrome's text) is returned
// as it is. kind: 'method' | 'get' | 'set'.
function chromeError(e, fn, kind, owner, name, thisValue, args) {
    if (typeof e !== 'object' || e === null)
        return e;
    if (WeakSetPrototypeHas(engineErrors, e)) {
        const d = ObjectGetOwnPropertyDescriptor(e, 'message');
        const match = d !== undefined && typeof d.value === 'string' ? RegExpPrototypeExec(NOT_AN_OBJECT_OF_TYPE, d.value) : null;
        if (match === null) {
            // The engine's argument-count messages in Chrome's words.
            const text = d !== undefined && typeof d.value === 'string' ? argumentCountMessage(d.value, args.length, "Failed to execute '" + name + "' on '" + owner + "': ") : null;
            return withStackFrom(text === null ? e : new HostTypeError(text), fn);
        }
        // "Not an object of type T": the receiver is wrong (Chrome: Illegal invocation) unless the receiver is fine and an
        // argument is the wrong kind of thing (Chrome names the parameter).
        const type = match[1];
        let text = 'Illegal invocation';
        if (args.length > 0 && owner !== '') {
            const ownClass = MapPrototypeGet(classByName, owner);
            const receiverOk = (typeof thisValue === 'object' || typeof thisValue === 'function') && thisValue !== null && WeakMapPrototypeGet(cellOf, thisValue) !== undefined
                && (thisValue === G || ownClass === undefined || thisValue instanceof ownClass);
            if (receiverOk) {
                const argClass = MapPrototypeGet(classByName, type);
                let index = -1;
                for (let i = 0; i < args.length && index < 0; i++)
                    if (argClass === undefined || !(args[i] instanceof argClass))
                        index = i;
                if (index >= 0) {
                    text = kind === 'set'
                        ? "Failed to set the '" + name + "' property on '" + owner + "': The provided value is not of type '" + type + "'."
                        : "Failed to execute '" + name + "' on '" + owner + "': parameter " + (index + 1) + " is not of type '" + type + "'.";
                }
            }
        }
        return withStackFrom(new HostTypeError(text), fn);
    }
    if (QUERY_METHODS[name] === true && kind === 'method' && args.length > 0) {
        // The engine's selector error becomes Chrome's.
        let message;
        try {
            message = e.message;
        } catch { return e; }
        if (message === 'Failed to parse selector') {
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (DOMExceptionClass !== undefined)
                return withStackFrom(new DOMExceptionClass("Failed to execute '" + name + "' on '" + owner + "': '" + HostString(args[0]) + "' is not a valid selector.", 'SyntaxError'), fn);
        }
    }
    return e;
}

// Whether a page may construct an interface (Chrome's list, 46-constructible.js): the engine has a constructor function for every
// interface and cannot be asked, and constructing to find out would build objects (some leave its execution context unbalanced).
function constructible(cls) {
    return MapPrototypeGet(CONSTRUCTIBLE_INTERFACES, cls.name) === true;
}

// "foo() needs one argument" / "Overload resolution failed" as Chrome says it: "<prefix>1 argument required, but only 0 present."
function argumentCountMessage(message, given, prefix) {
    let m = RegExpPrototypeExec(NEEDS_ARGUMENTS, message) || RegExpPrototypeExec(NEEDS_AT_LEAST_ARGUMENTS, message);
    let required;
    if (m !== null)
        required = m[1] === 'one' ? 1 : +m[1];
    else if (message === 'Overload resolution failed' && given === 0)
        required = 1;
    else
        return null;
    return prefix + required + (required === 1 ? ' argument' : ' arguments') + ' required, but only ' + given + ' present.';
}

// A constructor's engine errors: the HTML element that cannot be built directly says what Chrome's says.
function chromeConstructError(e, cls, args) {
    if (typeof e === 'object' && e !== null && WeakSetPrototypeHas(engineErrors, e)) {
        const d = ObjectGetOwnPropertyDescriptor(e, 'message');
        if (d !== undefined && (d.value === 'Cannot directly construct an HTML element, it must be inherited' || d.value === 'Illegal constructor'))
            return illegalConstructor(cls, true);
        const text = d !== undefined && typeof d.value === 'string' ? argumentCountMessage(d.value, args.length, "Failed to construct '" + cls.name + "': ") : null;
        return withStackFrom(text === null ? e : new HostTypeError(text), cls);
    }
    return e;
}

// --- The global --------------------------------------------------------------------------------------------------
const WORKER_ONLY_INTERFACES = ['FileReaderSync'];
const WINDOW_PROTOTYPE_KEEP = { __proto__: null, constructor: true, TEMPORARY: true, PERSISTENT: true };
// A page's global is a Window; in the segment it is a DedicatedWorkerGlobalScope whose prototype cannot be replaced (the
// global's prototype is immutable). So the objects on its chain become the Window's: the interface object is named Window and is
// the Worker's own function (calling it throws "Illegal constructor" natively), its prototype carries the Window's tag, and the
// WorkerGlobalScope prototype behind it becomes WindowProperties (no constructor, nothing of its own). The members they carried
// are the global's own, as on a Window.
function shapeWindowChain() {
    const proto = ObjectGetPrototypeOf(G);
    if (proto === null || proto === undefined)
        return;
    const tag = ObjectGetOwnPropertyDescriptor(proto, SymbolToStringTag);
    if (tag === undefined || tag.value !== 'DedicatedWorkerGlobalScope')
        return;
    checkGlobalReceivers = true;
    const props = ObjectGetPrototypeOf(proto);
    if (props === null || props === Object.prototype)
        return;
    const EngineWindow = MapPrototypeGet(classByName, 'Window');
    // The interface object is a function of ours (the Worker's own would name itself in V8's messages): it throws Chrome's
    // "Illegal constructor" and its `prototype` is the Worker's prototype object, which becomes Window.prototype.
    const WindowCtor = { Window: function () {
        throw illegalConstructor(WindowCtor, new.target !== undefined);
    } }.Window;
    ObjectDefineProperty(WindowCtor, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false });
    ObjectDefineProperty(proto, 'constructor', { value: WindowCtor, writable: true, enumerable: false, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, WindowCtor);
    // Constants and statics of the engine's Window go to the interface object that replaces it.
    if (EngineWindow !== undefined) {
        const copy = (from, to, skip) => {
            const keys = ReflectOwnKeys(from);
            for (let i = 0; i < keys.length; i++) {
                if (skip[keys[i]] === true)
                    continue;
                const d = ObjectGetOwnPropertyDescriptor(from, keys[i]);
                if (d !== undefined && !ObjectHasOwn(to, keys[i]))
                    ObjectDefineProperty(to, keys[i], d);
            }
        };
        copy(EngineWindow, WindowCtor, { __proto__: null, length: true, name: true, prototype: true });
        copy(EngineWindow.prototype, proto, { __proto__: null, constructor: true });
    }
    ObjectDefineProperty(proto, SymbolToStringTag, { value: 'Window', configurable: true });
    const EventTargetClass = MapPrototypeGet(classByName, 'EventTarget');
    if (EventTargetClass !== undefined)
        ObjectSetPrototypeOf(WindowCtor, EventTargetClass); // Window inherits EventTarget as an interface
    for (const [n, v] of [['TEMPORARY', 0], ['PERSISTENT', 1]]) {
        ObjectDefineProperty(WindowCtor, n, { value: v, writable: false, enumerable: true, configurable: false });
        if (!ObjectHasOwn(proto, n))
            ObjectDefineProperty(proto, n, { value: v, writable: false, enumerable: true, configurable: false });
    }
    // The Worker's global object owns a `constructor` (the Worker scope's); a Window's does not.
    ReflectDeleteProperty(G, 'constructor');
    // Members the Worker scopes carry move to the global itself (a Window owns them); the Worker-only ones go.
    const move = (from, keep) => {
        const keys = ReflectOwnKeys(from);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === SymbolToStringTag || (keep !== null && keep[key] === true))
                continue;
            const d = ObjectGetOwnPropertyDescriptor(from, key);
            if (d !== undefined && key !== 'fonts' && key !== 'constructor' && !ObjectHasOwn(G, key))
                ObjectDefineProperty(G, key, d);
            ReflectDeleteProperty(from, key);
        }
    };
    move(proto, WINDOW_PROTOTYPE_KEEP);
    move(props, null);
    ObjectDefineProperty(props, SymbolToStringTag, { value: 'WindowProperties', configurable: true });
    namedPropertiesObject = props;
    // Behind WindowProperties is the Worker's EventTarget.prototype, and the prototype of that object cannot be changed (the
    // prototype of a [Global] interface's prototype object is immutable in V8), so the page's EventTarget.prototype is made to
    // be that object: `window instanceof EventTarget` is true, and what a page defines on EventTarget.prototype (ShadyDOM's
    // __shady_native_addEventListener) is found from the window, as in Chrome. addEventListener, removeEventListener and
    // dispatchEvent are EventTarget.prototype's on a Window, not the global's own.
    const HostEventTargetPrototype = ObjectGetPrototypeOf(props);
    if (HostEventTargetPrototype !== null && HostEventTargetPrototype !== Object.prototype) {
        const EventTargetInterface = adoptEventTargetPrototype(HostEventTargetPrototype);
        if (EventTargetInterface !== null) {
            ObjectSetPrototypeOf(WindowCtor, EventTargetInterface);
            for (const n of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
                ReflectDeleteProperty(G, n);
        }
    }
    shapeWindowSize();
    // Interfaces only a Worker has.
    for (const n of WORKER_ONLY_INTERFACES)
        ReflectDeleteProperty(G, n);
    ObjectDefineProperty(G, 'Window', { value: WindowCtor, writable: true, enumerable: false, configurable: true });
}

// Named access on the window (window.someId, a bare `canvas` for <canvas id=canvas>): the Window's supported property names
// (ids, the names of embed/form/img/object, child navigable target names), as Chrome answers them from the named properties
// object behind Window.prototype. The global's prototype chain cannot take an exotic object, so WindowProperties carries an
// accessor per name that asks the engine's Window for the value now (an element, an HTMLCollection or a WindowProxy); the set
// of names is refreshed when the document's tree version moves (before and after each script, at each pump). Names the frame
// code keeps as data properties (55-realms.js syncFrameNames) are left to it. The global's own names and Window.prototype's
// win, as they do in Chrome.
let namedPropertiesObject = null;
let namedPropertiesVersion = -1;
let namedPropertyNames = [];
function namedPropertyGetter(name) {
    const get = function () {
        if (globalCell === 0)
            return undefined;
        const entered = idleEntry();
        try {
            return vGet(globalCell, name);
        } catch {
            return undefined;
        } finally {
            idleExit(entered);
        }
    };
    return get;
}
function syncNamedProperties() {
    const props = namedPropertiesObject;
    if (props === null || globalCell === 0 || typeof X.ganglion_window_named_keys !== 'function')
        return;
    const mark = scratchTop;
    const names = safeArray();
    try {
        const o = slots(1), v = slots(1);
        writeObject(o, globalCell);
        if (X.ganglion_window_named_keys(o, namedPropertiesVersion, v) === 0) {
            views();
            namedPropertiesVersion = f64[v >>> 3];
            return;
        }
        views();
        namedPropertiesVersion = f64[v >>> 3];
        const n = X.ganglion_keys_count();
        for (let i = 0; i < n; i++) {
            const key = keyToJS(X.ganglion_keys_at(i));
            if (typeof key === 'string')
                names[names.length] = key;
        }
    } finally {
        scratchTop = mark;
    }
    const keep = { __proto__: null };
    for (let i = 0; i < names.length; i++)
        keep[names[i]] = true;
    for (let i = 0; i < namedPropertyNames.length; i++) {
        const name = namedPropertyNames[i];
        if (keep[name] === true)
            continue;
        const d = ObjectGetOwnPropertyDescriptor(props, name);
        if (d !== undefined && d.get !== undefined && WeakSetPrototypeHas(namedPropertyGetters, d.get))
            ReflectDeleteProperty(props, name);
    }
    const kept = safeArray();
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const d = ObjectGetOwnPropertyDescriptor(props, name);
        if (d !== undefined) {
            // A frame's name (a data property of 55-realms.js) or an accessor of ours already there.
            if (d.get !== undefined && WeakSetPrototypeHas(namedPropertyGetters, d.get))
                kept[kept.length] = name;
            continue;
        }
        const get = namedPropertyGetter(name);
        WeakSetPrototypeAdd(namedPropertyGetters, get);
        // Chrome: a named property is writable and configurable, not enumerable ([LegacyUnenumerableNamedProperties]); an
        // assignment through the global defines an own property of the global, which then shadows it.
        ObjectDefineProperty(props, name, { get, set: namedPropertySetter(name), enumerable: false, configurable: true });
        kept[kept.length] = name;
    }
    namedPropertyNames = kept;
}
const namedPropertyGetters = new HostWeakSet();
function namedPropertySetter(name) {
    return function (value) {
        ObjectDefineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
    };
}

// The engine's EventTarget interface, rebuilt on `host`, the object that already stands behind the global's prototypes: the interface
// object is a new function whose prototype is `host` and that carries the engine's constructor cell; the engine's members are
// copied onto `host`; every interface that inherited the engine's prototype object (and every class made later) inherits `host`.
// The engine's old prototype object stays only for the few objects made from it before this runs.
function adoptEventTargetPrototype(host) {
    const old = MapPrototypeGet(classByName, 'EventTarget');
    if (old === undefined)
        return null;
    const protoCell = WeakMapPrototypeGet(cellOf, old.prototype);
    const ctorCell = WeakMapPrototypeGet(cellOf, old);
    if (protoCell === undefined || ctorCell === undefined)
        return null;
    const cls = makeClass('EventTarget', null, ctorCell, host);
    const keys = ReflectOwnKeys(old.prototype);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] === 'constructor')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(old.prototype, keys[i]);
        if (d !== undefined)
            ObjectDefineProperty(host, keys[i], d);
    }
    const statics = ReflectOwnKeys(old);
    for (let i = 0; i < statics.length; i++) {
        const k = statics[i];
        if (k === 'length' || k === 'name' || k === 'prototype')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(old, k);
        if (d !== undefined && !ObjectHasOwn(cls, k))
            ObjectDefineProperty(cls, k, d);
    }
    WeakMapPrototypeSet(cellOf, cls, ctorCell);
    WeakMapPrototypeSet(cellOf, host, protoCell);
    MapPrototypeSet(classByProto, protoCell, cls);
    MapPrototypeSet(classByName, 'EventTarget', cls);
    MapPrototypeSet(wrapperByCell, protoCell, host);
    MapPrototypeSet(wrapperByCell, ctorCell, cls);
    MapPrototypeSet(functionByCell, ctorCell, cls);
    for (const c of classByName.values()) {
        if (c === cls)
            continue;
        if (ObjectGetPrototypeOf(c.prototype) === old.prototype)
            ObjectSetPrototypeOf(c.prototype, host);
        if (ObjectGetPrototypeOf(c) === old)
            ObjectSetPrototypeOf(c, cls);
    }
    const g = ObjectGetOwnPropertyDescriptor(G, 'EventTarget');
    if (g !== undefined && g.value !== undefined)
        ObjectDefineProperty(G, 'EventTarget', { value: cls, writable: g.writable, enumerable: g.enumerable, configurable: g.configurable });
    return cls;
}

// innerWidth and innerHeight are the segment host's accessors (arrow functions over its state): a Window's are replaceable
// accessors with native getters and setters ("get innerWidth"), enumerable.
function shapeWindowSize() {
    // A window with no browser chrome around the page (the segment has none): its outer size is its inner size.
    const sources = { __proto__: null, innerWidth: 'innerWidth', innerHeight: 'innerHeight', outerWidth: 'innerWidth', outerHeight: 'innerHeight' };
    for (const name of ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight']) {
        const inner = ObjectGetOwnPropertyDescriptor(G, sources[name]);
        if (inner === undefined || inner.get === undefined)
            continue;
        const read = inner.get;
        const holder = {
            get [name]() {
                if (foreignReceiver(this, G))
                    throw illegalInvocation(nd.get);
                return read();
            },
            set [name](value) {
                if (foreignReceiver(this, G))
                    throw illegalInvocation(nd.set);
                ObjectDefineProperty(G, name, { value, writable: true, enumerable: true, configurable: true });
            },
        };
        const nd = ObjectGetOwnPropertyDescriptor(holder, name);
        WeakSetPrototypeAdd(nativeFunctions, nd.get);
        WeakSetPrototypeAdd(nativeFunctions, nd.set);
        ObjectDefineProperty(G, name, { get: nd.get, set: nd.set, enumerable: true, configurable: true });
    }
}

// --- Main-thread behaviours ---------------------------------------------------------------------------------------
// Atomics.wait throws on a page's main thread, and SharedArrayBuffer does not exist there without cross-origin isolation. The
// segment Worker is always isolated (Document-Isolation-Policy); the page is as its own COOP/COEP earn it in Chrome: the engine
// says so before each document's scripts run (Host.cpp ganglion_host_isolation, setPageIsolation), and the global follows.
const HostSharedArrayBuffer = globalThis.SharedArrayBuffer;
const SharedArrayBufferByteLength = HostSharedArrayBuffer ? uncurryThis(ObjectGetOwnPropertyDescriptor(HostSharedArrayBuffer.prototype, 'byteLength').get) : null;
const HostWasmMemory = globalThis.WebAssembly ? globalThis.WebAssembly.Memory : null;
let pageIsolated = false;
function isSharedArrayBuffer(v) {
    if (SharedArrayBufferByteLength === null || typeof v !== 'object' || v === null)
        return false;
    try {
        SharedArrayBufferByteLength(v);
        return true;
    } catch {
        return false;
    }
}
// Chrome's DataCloneError for a SharedArrayBuffer (or a shared WebAssembly.Memory) cloned without cross-origin isolation.
function sharedCloneError() {
    return new G.DOMException('SharedArrayBuffer transfer requires self.crossOriginIsolated.', 'DataCloneError');
}
function setPageIsolation(isolated) {
    pageIsolated = isolated;
    if (isolated && HostSharedArrayBuffer)
        ObjectDefineProperty(G, 'SharedArrayBuffer', { value: HostSharedArrayBuffer, writable: true, enumerable: false, configurable: true });
    else
        ReflectDeleteProperty(G, 'SharedArrayBuffer');
}
function shapeAtomics() {
    const atomics = globalThis.Atomics;
    if (atomics !== undefined) {
        const d = ObjectGetOwnPropertyDescriptor(atomics, 'wait');
        if (d !== undefined) {
            // V8 checks the arguments first (a typed array that is not shared throws its own message), then whether this thread may block:
            // the original runs with a timeout of 0, which never blocks, and what it accepts is refused for the thread.
            const original = d.value;
            const wait = { wait(typedArray, index, value, timeout) {
                try {
                    ReflectApply(original, atomics, [typedArray, index, value, 0]);
                } catch (e) {
                    throw withStackFrom(e, wait);
                }
                throw withStackFrom(new HostTypeError('Atomics.wait cannot be called in this context'), wait);
            } }.wait;
            WeakSetPrototypeAdd(nativeFunctions, wait);
            ObjectDefineProperty(atomics, 'wait', { value: wait, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
        }
    }
    ReflectDeleteProperty(G, 'SharedArrayBuffer');
}

// alert, confirm, prompt and print on a page block until the user has answered; the segment cannot block for a dialog, so they
// answer as a dismissed dialog does (no value), at once. print does nothing.
function shapeDialogs() {
    const define = (name, result) => {
        const f = { [name]() {
            if (foreignReceiver(this, G))
                throw illegalInvocation(f);
            return result;
        } }[name];
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(G, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    define('alert', undefined);
    define('confirm', false);
    define('prompt', null);
    define('print', undefined);
}

// window.chrome: what Chrome gives every page (loadTimes, csi, app; runtime only to extension pages).
function shapeChromeObject() {
    if (ObjectHasOwn(G, 'chrome'))
        return;
    // Chrome's functions here are anonymous native ones: name "", printing as `function () { [native code] }`.
    const fn = (length, body) => {
        const f = { f: function (...args) { return body(args); } }.f; // (a plain function: Chrome's have a prototype)
        ObjectDefineProperty(f, 'name', { value: '', configurable: true });
        ObjectDefineProperty(f, 'length', { value: length, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        return f;
    };
    const now = () => (hostPerformance !== undefined ? hostPerformance.timeOrigin + hostPerformance.now() : 0) / 1000;
    const origin = () => (hostPerformance !== undefined ? hostPerformance.timeOrigin : 0) / 1000;
    const data = (value, writable) => ({ value, writable, enumerable: true, configurable: true });
    const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
    const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
    const app = {};
    ObjectDefineProperties(app, {
        isInstalled: data(false, false),
        getDetails: data(fn(0, () => null), true),
        getIsInstalled: data(fn(0, () => false), true),
        installState: data(fn(0, (args) => { if (typeof args[0] === 'function') args[0]('not_installed'); }), true),
        runningState: data(fn(0, () => 'cannot_run'), true),
        InstallState: data(InstallState, false),
        RunningState: data(RunningState, false),
    });
    const chrome = {};
    ObjectDefineProperties(chrome, {
        loadTimes: data(fn(0, () => {
            const t = origin();
            return {
                requestTime: t, startLoadTime: t, commitLoadTime: t + 0.05, finishDocumentLoadTime: now(), finishLoadTime: now(),
                firstPaintTime: t + 0.1, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
                npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
            };
        }), true),
        csi: data(fn(0, () => {
            const t = origin() * 1000;
            return { startE: HostMath.round(t), onloadT: HostMath.round(t + 100), pageT: hostPerformance !== undefined ? hostPerformance.now() : 0, tran: 15 };
        }), true),
        app: data(app, true),
    });
    ObjectDefineProperty(G, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: true });
}

// performance.memory, which Chrome has (and Workers too): the Worker's own numbers.
const hostMemoryDescriptor = hostPerformance !== undefined ? (() => { for (let o = hostPerformance; o !== null; o = ObjectGetPrototypeOf(o)) { const d = ObjectGetOwnPropertyDescriptor(o, 'memory'); if (d !== undefined) return d; } return undefined; })() : undefined;
// Workers have no performance.memory; the numbers of a plain page (limit 4 GiB; a small heap growing a little with time, in the
// 100 KB steps Chrome rounds to) stand in. Honest about what they are: not this Worker's heap.
function syntheticMemory(key) {
    const t = hostPerformance !== undefined ? hostPerformance.now() : 0;
    const total = 19000000 + MathFloor(MathMin(t, 600000) / 1000) * 100000;
    if (key === 'jsHeapSizeLimit') return 4294967296;
    if (key === 'totalJSHeapSize') return total;
    return total - 5300000 + MathFloor((t % 7000) / 100) * 100000;
}
// navigator.hardwareConcurrency and deviceMemory: the engine's constants (1 and 1: a container that looks like a bot) give way to what
// the host browser reports to its own pages, which the glue reads as it loads, before the host script removes its doors.
const hostNavigator = globalThis.navigator;
const HOST_NAVIGATOR_VALUES = { __proto__: null };
for (const k of ['hardwareConcurrency', 'deviceMemory']) {
    try {
        if (hostNavigator !== undefined && typeof hostNavigator[k] === 'number')
            HOST_NAVIGATOR_VALUES[k] = hostNavigator[k];
    } catch { /* not available */ }
}
// The platform identity (docs/surface.md, Decisions 2026-10-22, option B): the host Chrome's own user agent with a coarse
// `Chitin/0` token appended, as Edge appends `Edg/...`. The same for every user on a platform: no build id, no version beyond 0.
// navigator.userAgent, appVersion, platform and userAgentData are built from it here, and boot() hands the same strings to the
// engine for the User-Agent and Sec-CH-UA request headers (ganglion_set_identity), so a page and the wire say one thing.
const CHITIN_TOKEN = 'Chitin/0';
const uaJoin = uncurryThis(Array.prototype.join), uaMap = uncurryThis(Array.prototype.map), uaFilter = uncurryThis(Array.prototype.filter), uaConcat = uncurryThis(Array.prototype.concat);
const uaFrom = Array.from;
const FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const hostUAData = (() => { try { return hostNavigator !== undefined ? hostNavigator.userAgentData : undefined; } catch { return undefined; } })();
const HOST_UA = (() => {
    try {
        const ua = hostNavigator !== undefined ? hostNavigator.userAgent : undefined;
        if (typeof ua === 'string' && ua.startsWith('Mozilla/5.0 ') && /Chrome\/\d/.test(ua))
            return ua;
    } catch { /* not available */ }
    return FALLBACK_UA;
})();
const CHROME_MAJOR = (() => { const m = /Chrome\/(\d+)/.exec(HOST_UA); return m !== null ? m[1] : '154'; })();
const IDENTITY = (() => {
    const ua = HOST_UA.endsWith(' ' + CHITIN_TOKEN) ? HOST_UA : HOST_UA + ' ' + CHITIN_TOKEN;
    let platformUA = 'Linux';
    if (HOST_UA.includes('Macintosh')) platformUA = 'macOS';
    else if (HOST_UA.includes('Windows')) platformUA = 'Windows';
    else if (HOST_UA.includes('CrOS')) platformUA = 'Chrome OS';
    else if (HOST_UA.includes('Android')) platformUA = 'Android';
    let brands = [];
    try {
        if (hostUAData !== undefined && hostUAData.brands !== undefined)
            for (const b of hostUAData.brands)
                brands.push({ brand: String(b.brand), version: String(b.version) });
    } catch { brands = []; }
    if (brands.length === 0)
        brands = [{ brand: 'Chromium', version: CHROME_MAJOR }, { brand: 'Not.A/Brand', version: '24' }, { brand: 'Google Chrome', version: CHROME_MAJOR }];
    brands = brands.filter((b) => b.brand !== 'Chitin');
    brands.push({ brand: 'Chitin', version: '0' });
    let mobile = HOST_UA.includes(' Mobile');
    let platform = platformUA;
    try {
        if (hostUAData !== undefined) {
            if (typeof hostUAData.mobile === 'boolean') mobile = hostUAData.mobile;
            if (typeof hostUAData.platform === 'string' && hostUAData.platform !== '') platform = hostUAData.platform;
        }
    } catch { /* keep the UA's */ }
    let navPlatform = 'Linux x86_64';
    try {
        if (hostNavigator !== undefined && typeof hostNavigator.platform === 'string' && hostNavigator.platform !== '' && hostNavigator.platform !== 'WebAssembly wasm32')
            navPlatform = hostNavigator.platform;
        else if (platform === 'macOS') navPlatform = 'MacIntel';
        else if (platform === 'Windows') navPlatform = 'Win32';
    } catch { /* keep the default */ }
    const secChUa = uaJoin(uaMap(brands, (b) => '"' + b.brand + '";v="' + b.version + '"'), ', ');
    // What a URL the site-compatibility list hides Chitin from (webcompat/, "user_agent": ["hide_Chitin"]) is shown and sent:
    // the host Chrome's own user agent and brands, without the Chitin token or brand.
    const hiddenUA = ua.slice(0, ua.length - CHITIN_TOKEN.length - 1);
    const hiddenBrands = brands.filter((b) => b.brand !== 'Chitin');
    const secChUaHidden = uaJoin(uaMap(hiddenBrands, (b) => '"' + b.brand + '";v="' + b.version + '"'), ', ');
    return { userAgent: ua, appVersion: ua.slice('Mozilla/'.length), platform: navPlatform, brands, mobile, uaPlatform: platform,
        secChUa, secChMobile: mobile ? '?1' : '?0', secChPlatform: '"' + platform + '"',
        hidden: { userAgent: hiddenUA, appVersion: hiddenUA.slice('Mozilla/'.length), brands: hiddenBrands, secChUa: secChUaHidden } };
})();
// The hints Chrome adds on request (getHighEntropyValues), read from the host as it loads; the Chitin brand has full version 0.0.0.0.
let hostHighEntropy = null;
if (hostUAData !== undefined && typeof hostUAData.getHighEntropyValues === 'function') {
    try {
        hostHighEntropy = hostUAData.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64']).then((v) => v, () => null);
    } catch { hostHighEntropy = null; }
}
function identityHeaderBlock() {
    return IDENTITY.userAgent + '\n' + IDENTITY.secChUa + '\n' + IDENTITY.secChMobile + '\n' + IDENTITY.secChPlatform + '\n' + IDENTITY.hidden.secChUa;
}
// Whether the site-compatibility list hides Chitin from this navigator's document: the engine's own navigator.userAgent
// (LibWeb's NavigatorID, which asks the list for the document's URL) says so by leaving the token out.
function chitinHiddenFor(engineUserAgentGetter, navigator) {
    if (engineUserAgentGetter === undefined)
        return false;
    let ua;
    try {
        ua = ReflectApply(engineUserAgentGetter, navigator, []);
    } catch {
        return false;
    }
    return typeof ua === 'string' && !ua.endsWith(' ' + CHITIN_TOKEN);
}
function shapeUserAgentData(cls, engineUserAgentGetter) {
    // (The host's own NavigatorUAData is on the global already, with the host's brands only; this one replaces it.)
    const UAData = makeClass('NavigatorUAData', null, 0);
    ObjectDefineProperty(UAData.prototype, SymbolToStringTag, { value: 'NavigatorUAData', configurable: true });
    // Two instances: the one most documents see, and the one a document the site-compatibility list hides Chitin from sees.
    const instance = ReflectConstruct(function () {}, [], UAData);
    const hiddenInstance = ReflectConstruct(function () {}, [], UAData);
    const brandsShown = ObjectFreeze(uaMap(IDENTITY.brands, (b) => ({ brand: b.brand, version: b.version })));
    const brandsHidden = ObjectFreeze(uaMap(IDENTITY.hidden.brands, (b) => ({ brand: b.brand, version: b.version })));
    const getter = (name, value, hiddenValue) => {
        const holder = { get [name]() {
            if (this !== instance && this !== hiddenInstance)
                throw illegalInvocation(g);
            return this === hiddenInstance ? hiddenValue : value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, name).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(UAData.prototype, name, { get: g, set: undefined, enumerable: true, configurable: true });
    };
    getter('brands', brandsShown, brandsHidden);
    getter('mobile', IDENTITY.mobile, IDENTITY.mobile);
    getter('platform', IDENTITY.uaPlatform, IDENTITY.uaPlatform);
    const methods = {
        getHighEntropyValues(hints) {
            if (this !== instance && this !== hiddenInstance)
                return PromiseReject(illegalInvocation(methods.getHighEntropyValues));
            const hidden = this === hiddenInstance;
            const brands = hidden ? brandsHidden : brandsShown;
            if (arguments.length < 1)
                return PromiseReject(withStackFrom(new HostTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present."), methods.getHighEntropyValues));
            const wanted = uaFrom(hints, String);
            return (async () => {
                const host = hostHighEntropy !== null ? await hostHighEntropy : null;
                const out = { brands, mobile: IDENTITY.mobile, platform: IDENTITY.uaPlatform };
                const h = host !== null && host !== undefined ? host : {};
                for (const k of wanted) {
                    if (k === 'fullVersionList') {
                        const base = h.fullVersionList !== undefined ? uaMap(h.fullVersionList, (b) => ({ brand: String(b.brand), version: String(b.version) })) : uaMap(IDENTITY.brands, (b) => ({ brand: b.brand, version: b.brand === 'Not.A/Brand' ? b.version + '.0.0.0' : CHROME_MAJOR + '.0.0.0' }));
                        out.fullVersionList = hidden ? uaFilter(base, (b) => b.brand !== 'Chitin') : uaConcat(uaFilter(base, (b) => b.brand !== 'Chitin'), [{ brand: 'Chitin', version: '0.0.0.0' }]);
                    } else if (k === 'uaFullVersion')
                        out.uaFullVersion = h.uaFullVersion !== undefined ? h.uaFullVersion : CHROME_MAJOR + '.0.0.0';
                    else if (k === 'architecture') out.architecture = h.architecture !== undefined ? h.architecture : 'x86';
                    else if (k === 'bitness') out.bitness = h.bitness !== undefined ? h.bitness : '64';
                    else if (k === 'model') out.model = h.model !== undefined ? h.model : '';
                    else if (k === 'platformVersion') out.platformVersion = h.platformVersion !== undefined ? h.platformVersion : '0.0.0';
                    else if (k === 'wow64') out.wow64 = h.wow64 !== undefined ? h.wow64 : false;
                    else if (k === 'formFactors') out.formFactors = h.formFactors !== undefined ? h.formFactors : ['Desktop'];
                }
                return out;
            })();
        },
        toJSON() {
            if (this !== instance && this !== hiddenInstance)
                throw illegalInvocation(methods.toJSON);
            const brands = this === hiddenInstance ? brandsHidden : brandsShown;
            return { brands: uaMap(brands, (b) => ({ brand: b.brand, version: b.version })), mobile: IDENTITY.mobile, platform: IDENTITY.uaPlatform };
        },
    };
    for (const name of ['getHighEntropyValues', 'toJSON']) {
        WeakSetPrototypeAdd(nativeFunctions, methods[name]);
        ObjectDefineProperty(UAData.prototype, name, { value: methods[name], writable: true, enumerable: true, configurable: true });
    }
    ObjectDefineProperty(G, 'NavigatorUAData', { value: UAData, writable: true, enumerable: false, configurable: true });
    const holder = { get userAgentData() {
        if (notWrapper(this))
            throw illegalInvocation(g);
        return chitinHiddenFor(engineUserAgentGetter, this) ? hiddenInstance : instance;
    } };
    const g = ObjectGetOwnPropertyDescriptor(holder, 'userAgentData').get;
    WeakSetPrototypeAdd(nativeFunctions, g);
    ObjectDefineProperty(cls.prototype, 'userAgentData', { get: g, set: undefined, enumerable: true, configurable: true });
}
function shapeNavigator(cls) {
    const engineUA = ObjectGetOwnPropertyDescriptor(cls.prototype, 'userAgent');
    const engineUserAgentGetter = engineUA !== undefined ? engineUA.get : undefined;
    for (const key of ['userAgent', 'appVersion', 'platform']) {
        const d = ObjectGetOwnPropertyDescriptor(cls.prototype, key);
        const value = IDENTITY[key];
        const hiddenValue = key === 'platform' ? value : IDENTITY.hidden[key];
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return chitinHiddenFor(engineUserAgentGetter, this) ? hiddenValue : value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: d !== undefined ? d.enumerable : true, configurable: d !== undefined ? d.configurable : true });
    }
    shapeUserAgentData(cls, engineUserAgentGetter);
    for (const key of ['hardwareConcurrency', 'deviceMemory']) {
        const d = ObjectGetOwnPropertyDescriptor(cls.prototype, key);
        if (d === undefined || d.get === undefined || HOST_NAVIGATOR_VALUES[key] === undefined)
            continue;
        const value = HOST_NAVIGATOR_VALUES[key];
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: d.enumerable, configurable: d.configurable });
    }
}
// navigator.webkitTemporaryStorage and webkitPersistentStorage: Chrome's DeprecatedStorageQuota (one object for both, its interface not
// on the global), which sites still probe (cnn.com reads queryUsageAndQuota). Usage and quota are navigator.storage.estimate()'s, as
// Chrome answers both from the quota manager; requestQuota grants what is asked up to the quota. Callbacks come later, never in the call.
function shapeDeprecatedStorageQuota(cls) {
    if (ObjectGetOwnPropertyDescriptor(cls.prototype, 'webkitTemporaryStorage') !== undefined)
        return;
    const proto = {};
    ObjectDefineProperty(proto, SymbolToStringTag, { value: 'DeprecatedStorageQuota', configurable: true });
    const quota = ObjectCreate(proto);
    const failed = (op, what) => new HostTypeError("Failed to execute '" + op + "' on 'DeprecatedStorageQuota': " + what);
    const later = (estimate, onError, then) => {
        let p;
        try {
            p = G.navigator.storage.estimate();
        } catch (e) {
            p = PromiseReject(e);
        }
        p.then((e) => then(e && typeof e.usage === 'number' ? e.usage : 0, e && typeof e.quota === 'number' ? e.quota : 0), (e) => {
            if (typeof onError === 'function')
                onError(e);
        }).catch((e) => { try { G.reportError(e); } catch { /* nothing more to do */ } });
    };
    const method = (name, body) => {
        const f = { [name](...args) {
            if (this !== quota)
                throw illegalInvocation(f);
            return body(args);
        } }[name];
        ObjectDefineProperty(f, 'length', { value: 1, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(proto, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    method('queryUsageAndQuota', (args) => {
        if (args.length < 1)
            throw failed('queryUsageAndQuota', '1 argument required, but only 0 present.');
        const [onUsage, onError] = args;
        if (typeof onUsage !== 'function')
            throw failed('queryUsageAndQuota', "parameter 1 is not of type 'Function'.");
        if (onError !== undefined && onError !== null && typeof onError !== 'function')
            throw failed('queryUsageAndQuota', "parameter 2 is not of type 'Function'.");
        later(true, onError, (usage, q) => onUsage(usage, q));
    });
    method('requestQuota', (args) => {
        if (args.length < 1)
            throw failed('requestQuota', '1 argument required, but only 0 present.');
        const [size, onGranted, onError] = args;
        const wanted = +size;
        if (onGranted !== undefined && onGranted !== null && typeof onGranted !== 'function')
            throw failed('requestQuota', "parameter 2 is not of type 'Function'.");
        if (onError !== undefined && onError !== null && typeof onError !== 'function')
            throw failed('requestQuota', "parameter 3 is not of type 'Function'.");
        later(false, onError, (usage, q) => { if (typeof onGranted === 'function') onGranted(MathMin(wanted > 0 ? wanted : 0, q)); });
    });
    for (const key of ['webkitTemporaryStorage', 'webkitPersistentStorage']) {
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return quota;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: true, configurable: true });
    }
}
function shapeClass(name, cls) {
    if (name === 'Navigator') {
        shapeNavigator(cls);
        shapeDeprecatedStorageQuota(cls);
    }
    if (name === 'Crypto')
        shapeCrypto(cls);
    if (name === 'SubtleCrypto')
        shapeSubtleCrypto(cls);
    shapeIterator(name, cls);
    if (name === 'Performance' && !ObjectHasOwn(cls.prototype, 'memory')) {
        const MemoryInfo = makeClass('MemoryInfo', null, 0);
        ObjectDefineProperty(MemoryInfo.prototype, SymbolToStringTag, { value: 'MemoryInfo', configurable: true });
        const numbers = ['jsHeapSizeLimit', 'totalJSHeapSize', 'usedJSHeapSize'];
        for (let i = 0; i < numbers.length; i++) {
            const key = numbers[i];
            const getter = { get [key]() {
                if (!(this instanceof MemoryInfo))
                    throw illegalInvocation(getter);
                return hostMemoryValue(key);
            } };
            const g = ObjectGetOwnPropertyDescriptor(getter, key).get;
            WeakSetPrototypeAdd(nativeFunctions, g);
            ObjectDefineProperty(MemoryInfo.prototype, key, { get: g, set: undefined, enumerable: true, configurable: true });
        }
        const info = ReflectConstruct(function () {}, [], MemoryInfo); // an instance without running the interface's constructor
        const memory = { get memory() {
            if (!(this instanceof cls))
                throw illegalInvocation(memoryGetter);
            return info;
        } };
        const memoryGetter = ObjectGetOwnPropertyDescriptor(memory, 'memory').get;
        WeakSetPrototypeAdd(nativeFunctions, memoryGetter);
        ObjectDefineProperty(cls.prototype, 'memory', { get: memoryGetter, set: undefined, enumerable: true, configurable: true });
    }
}
// crypto.getRandomValues (docs/crypto.md): the engine's JS runtime has no DataView, so the bridge hands it a DataView as the
// Uint8Array over the same bytes and the engine filled it; WebCrypto says TypeMismatchError. Both errors in Chrome's words.
const GRV_INTEGER_TAGS = { __proto__: null, Int8Array: true, Uint8Array: true, Uint8ClampedArray: true, Int16Array: true, Uint16Array: true, Int32Array: true, Uint32Array: true, BigInt64Array: true, BigUint64Array: true };
function shapeCrypto(cls) {
    const d = ObjectGetOwnPropertyDescriptor(cls.prototype, 'getRandomValues');
    if (d === undefined || typeof d.value !== 'function')
        return;
    const engineGetRandomValues = d.value;
    const method = { getRandomValues(array) {
        if (arguments.length > 0 && ArrayBufferIsView(array)) {
            const tag = TypedArrayTag(array);
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (DOMExceptionClass !== undefined && GRV_INTEGER_TAGS[tag] !== true)
                throw withStackFrom(new DOMExceptionClass("Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" + (tag === undefined ? 'DataView' : StringPrototypeSlice(tag, 0, tag.length - 5)) + "', which is not an integer array type.", 'TypeMismatchError'), method);
            const length = TypedArrayByteLength(array);
            if (DOMExceptionClass !== undefined && length > 65536)
                throw withStackFrom(new DOMExceptionClass("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + length + ') exceeds the number of bytes of entropy available via this API (65536).', 'QuotaExceededError'), method);
        }
        try {
            return ReflectApply(engineGetRandomValues, this, arguments);
        } catch (e) {
            throw withStackFrom(e, method);
        }
    } }.getRandomValues;
    WeakSetPrototypeAdd(nativeFunctions, method);
    ObjectDefineProperty(cls.prototype, 'getRandomValues', { value: method, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
}
// Chrome 154 has no ML-KEM members on SubtleCrypto (encapsulateKey/Bits, decapsulateKey/Bits): a page that tests for them
// would take a path Chrome never takes.
function shapeSubtleCrypto(cls) {
    const names = ['encapsulateKey', 'encapsulateBits', 'decapsulateKey', 'decapsulateBits'];
    for (let i = 0; i < names.length; i++)
        ReflectDeleteProperty(cls.prototype, names[i]);
}
// A pair iterable's @@iterator is its entries (a set-like's is its values), the same function: Chrome's `[Symbol.iterator].name` is
// "entries"; the engine makes a function of its own named "[Symbol.iterator]".
const SET_LIKE_INTERFACES = { __proto__: null, FontFaceSet: true, CustomStateSet: true, ViewTransitionTypeSet: true };
function shapeIterator(name, cls) {
    const proto = cls.prototype;
    const a = ObjectGetOwnPropertyDescriptor(proto, SymbolAsyncIterator);
    if (a !== undefined && typeof a.value === 'function' && WeakSetPrototypeHas(nativeFunctions, a.value) && a.value.name === '[Symbol.asyncIterator]') {
        const v = ObjectGetOwnPropertyDescriptor(proto, 'values');
        if (v !== undefined && typeof v.value === 'function')
            ObjectDefineProperty(proto, SymbolAsyncIterator, { value: v.value, writable: true, enumerable: false, configurable: true });
    }
    const d = ObjectGetOwnPropertyDescriptor(proto, SymbolIterator);
    if (d === undefined || typeof d.value !== 'function' || !WeakSetPrototypeHas(nativeFunctions, d.value) || d.value.name !== '[Symbol.iterator]')
        return;
    const keys = SET_LIKE_INTERFACES[name] === true ? ['values', 'entries'] : ['entries', 'values'];
    for (let i = 0; i < keys.length; i++) {
        const e = ObjectGetOwnPropertyDescriptor(proto, keys[i]);
        if (e !== undefined && typeof e.value === 'function') {
            ObjectDefineProperty(proto, SymbolIterator, { value: e.value, writable: true, enumerable: false, configurable: true });
            return;
        }
    }
}

function hostMemoryValue(key) {
    if (hostMemoryDescriptor !== undefined && hostMemoryDescriptor.get !== undefined) {
        try {
            return ReflectApply(hostMemoryDescriptor.get, hostPerformance, [])[key];
        } catch { /* fall through */ }
    }
    return syntheticMemory(key);
}

// webkitRequestFileSystem and webkitResolveLocalFileSystemURL exist on a Chrome page (the Worker's were removed as doors); the
// segment has no file system to give, so they answer as a page does when the browser refuses: the error callback, later, with a
// SecurityError.
function shapeFileSystem() {
    const define = (name, length, errorIndex) => {
        const f = { [name](...args) {
            if (foreignReceiver(this, G))
                throw illegalInvocation(f);
            const onError = args[errorIndex];
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (typeof onError === 'function' && DOMExceptionClass !== undefined)
                HostQueueMicrotask(() => { try { onError(new DOMExceptionClass('It was determined that certain files are unsafe for access within a Web application, or that too many calls are being made on file resources.', 'SecurityError')); } catch (e) { try { G.reportError(e); } catch { /* nothing more to do */ } } });
        } }[name];
        ObjectDefineProperty(f, 'length', { value: length, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(G, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    define('webkitRequestFileSystem', 3, 3);
    define('webkitResolveLocalFileSystemURL', 2, 2);
}

function shapeSurface() {
    shapeWindowChain();
    shapeAtomics();
    shapeDialogs();
    shapeChromeObject();
    shapeFileSystem();
}

// ===== glue/engine/46-constructible.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the interfaces Chrome lets a page construct (generated by tools/surface-diff/gen-constructible.mjs from Chrome
// 154.0.8037.92; 364 of 920). Calling one of the others throws "Illegal constructor", calling these
// without new throws "Please use the 'new' operator". See 45-surface.js.

const CONSTRUCTIBLE_INTERFACES = new HostMap();
for (const n of 'AbortController AbsoluteOrientationSensor Accelerometer AnalyserNode Animation AnimationEvent AnimationPlaybackEvent Audio AudioBuffer AudioBufferSourceNode AudioContext AudioData AudioDecoder AudioEncoder AudioProcessingEvent AudioWorkletNode BarcodeDetector BeforeInstallPromptEvent BiquadFilterNode Blob BlobEvent BroadcastChannel ByteLengthQueuingStrategy CSSKeywordValue CSSMathClamp CSSMathInvert CSSMathMax CSSMathMin CSSMathNegate CSSMathProduct CSSMathSum CSSMatrixComponent CSSPerspective CSSPositionValue CSSRotate CSSScale CSSSkew CSSSkewX CSSSkewY CSSStyleSheet CSSTransformValue CSSTranslate CSSUnitValue CSSUnparsedValue CSSVariableReferenceValue CaptureController ChannelMergerNode ChannelSplitterNode CharacterBoundsUpdateEvent ClipboardChangeEvent ClipboardEvent ClipboardItem CloseEvent CloseWatcher CommandEvent Comment CompositionEvent CompressionStream ConstantSourceNode ContentVisibilityAutoStateChangeEvent ConvolverNode CookieChangeEvent CountQueuingStrategy CustomElementRegistry CustomEvent DOMError DOMException DOMMatrix DOMMatrixReadOnly DOMParser DOMPoint DOMPointReadOnly DOMQuad DOMRect DOMRectReadOnly DataTransfer DecompressionStream DelayNode DeviceMotionEvent DeviceOrientationEvent Document DocumentFragment DocumentPictureInPictureEvent DocumentTimeline DragEvent DynamicsCompressorNode EditContext EncodedAudioChunk EncodedVideoChunk ErrorEvent Event EventSource EventTarget EyeDropper FederatedCredential File FileReader FileSystemObserver FocusEvent FontFace FontFaceSetLoadEvent FormData FormDataEvent GPUInternalError GPUOutOfMemoryError GPUPipelineError GPUUncapturedErrorEvent GPUValidationError GainNode GamepadEvent GravitySensor Gyroscope HIDConnectionEvent HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBRElement HTMLBaseElement HTMLBodyElement HTMLButtonElement HTMLCanvasElement HTMLDListElement HTMLDataElement HTMLDataListElement HTMLDetailsElement HTMLDialogElement HTMLDirectoryElement HTMLDivElement HTMLElement HTMLEmbedElement HTMLFencedFrameElement HTMLFieldSetElement HTMLFontElement HTMLFormElement HTMLFrameElement HTMLFrameSetElement HTMLGeolocationElement HTMLHRElement HTMLHeadElement HTMLHeadingElement HTMLHtmlElement HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLLIElement HTMLLabelElement HTMLLegendElement HTMLLinkElement HTMLMapElement HTMLMarqueeElement HTMLMenuElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLOListElement HTMLObjectElement HTMLOptGroupElement HTMLOptionElement HTMLOutputElement HTMLParagraphElement HTMLParamElement HTMLPictureElement HTMLPreElement HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSelectedContentElement HTMLSlotElement HTMLSourceElement HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableElement HTMLTableRowElement HTMLTableSectionElement HTMLTemplateElement HTMLTextAreaElement HTMLTimeElement HTMLTitleElement HTMLTrackElement HTMLUListElement HTMLVideoElement HashChangeEvent Headers Highlight IDBVersionChangeEvent IIRFilterNode IdentityCredentialError IdleDetector Image ImageCapture ImageData ImageDecoder InputDeviceCapabilities InputEvent InterestEvent IntersectionObserver KeyboardEvent KeyframeEffect LinearAccelerationSensor MIDIConnectionEvent MIDIMessageEvent MediaElementAudioSourceNode MediaEncryptedEvent MediaKeyMessageEvent MediaMetadata MediaQueryListEvent MediaRecorder MediaSource MediaStream MediaStreamAudioDestinationNode MediaStreamAudioSourceNode MediaStreamEvent MediaStreamTrackEvent MediaStreamTrackGenerator MediaStreamTrackProcessor MessageChannel MessageEvent MouseEvent MutationObserver NavigateEvent NavigationCurrentEntryChangeEvent Notification Observable OfflineAudioCompletionEvent OfflineAudioContext OffscreenCanvas Option Origin OscillatorNode OverconstrainedError PageRevealEvent PageSwapEvent PageTransitionEvent PannerNode PasswordCredential Path2D PaymentMethodChangeEvent PaymentRequest PaymentRequestUpdateEvent PerformanceMark PerformanceObserver PeriodicWave PictureInPictureEvent PointerEvent PopStateEvent PresentationConnectionAvailableEvent PresentationConnectionCloseEvent PresentationRequest PressureObserver Profiler ProgressEvent PromiseRejectionEvent QuotaExceededError RTCDTMFToneChangeEvent RTCDataChannelEvent RTCEncodedAudioFrame RTCEncodedVideoFrame RTCError RTCErrorEvent RTCIceCandidate RTCPeerConnection RTCPeerConnectionIceErrorEvent RTCPeerConnectionIceEvent RTCRtpScriptTransform RTCSessionDescription RTCTrackEvent Range ReadableStream ReadableStreamBYOBReader ReadableStreamDefaultReader RelativeOrientationSensor ReportingObserver Request ResizeObserver Response Sanitizer ScrollTimeline SecurityPolicyViolationEvent SensorErrorEvent SharedWorker SpeechGrammar SpeechGrammarList SpeechRecognition SpeechRecognitionErrorEvent SpeechRecognitionEvent SpeechRecognitionPhrase SpeechSynthesisErrorEvent SpeechSynthesisEvent SpeechSynthesisUtterance StaticRange StereoPannerNode StorageEvent SubmitEvent TaskController TaskPriorityChangeEvent Text TextDecoder TextDecoderStream TextEncoder TextEncoderStream TextFormat TextFormatUpdateEvent TextUpdateEvent TimelineTrigger ToggleEvent Touch TouchEvent TrackEvent TransformStream TransitionEvent UIEvent URL URLPattern URLSearchParams USBAlternateInterface USBConfiguration USBConnectionEvent USBEndpoint USBInTransferResult USBInterface USBIsochronousInTransferPacket USBIsochronousInTransferResult USBIsochronousOutTransferPacket USBIsochronousOutTransferResult USBOutTransferResult VTTCue VideoColorSpace VideoDecoder VideoEncoder VideoFrame ViewTimeline VirtualKeyboardGeometryChangeEvent WaveShaperNode WebGLContextEvent WebKitCSSMatrix WebKitMutationObserver WebMCPEvent WebSocket WebSocketError WebSocketStream WebTransport WebTransportError WheelEvent WindowControlsOverlayGeometryChangeEvent Worker WritableStream WritableStreamDefaultWriter XMLHttpRequest XMLSerializer XPathEvaluator XRInputSourceEvent XRInputSourcesChangeEvent XRLayerEvent XRRay XRReferenceSpaceEvent XRRigidTransform XRSessionEvent XRVisibilityMaskChangeEvent XRWebGLBinding XRWebGLLayer'.split(' '))
    MapPrototypeSet(CONSTRUCTIBLE_INTERFACES, n, true);

// ===== glue/engine/50-frames.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: cross-site iframes as nested segments (docs/architecture.md "Nested segments").
// The parent's engine never loads a cross-site iframe (its browsing context stays about:blank); this file lists
// those iframes for the host (api.subframes), gives the page a cross-origin WindowProxy stand-in for each
// (iframe.contentWindow; contentDocument is null), and in a child gives window.parent / window.top the same kind
// of stand-in. postMessage on a stand-in goes to the host (options.frames.post), which hands it to the carapace;
// the carapace checks targetOrigin and stamps the sender's origin. A message from the other segment arrives
// through api.deliverMessage and is fired as a trusted MessageEvent whose `source` is the stand-in. MessagePorts
// in a transfer are bridged over host MessagePorts (host structured clone, both ways).

const ORIGIN_RE = /^(https?):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(?:[/?#]|$)/i;
const RegExpPrototypeExec = uncurryThis(RegExp.prototype.exec);
const StringPrototypeToLowerCase = uncurryThis(HostString.prototype.toLowerCase);
const StringPrototypeSplit = uncurryThis(HostString.prototype.split);
const ArrayPrototypeJoin = uncurryThis(Array.prototype.join);
const ArrayPrototypeSlice = uncurryThis(Array.prototype.slice);
const ArrayFrom = Array.from;
const FramesMap = globalThis.Map;

// The origin of an http(s) URL, or null (the glue has no URL parser of its own).
function urlOrigin(url) {
    const m = RegExpPrototypeExec(ORIGIN_RE, HostString(url));
    if (m === null)
        return null;
    const scheme = StringPrototypeToLowerCase(m[1]);
    const host = StringPrototypeToLowerCase(m[2]);
    if (host === '')
        return null;
    let port = m[3] || '';
    if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80'))
        port = '';
    return scheme + '://' + host + (port ? ':' + port : '');
}
// The registrable domain by the Public Suffix List (glue/cookies.js), as harness/carapace/guard.mjs siteOf (the carapace checks
// again).
function urlSite(url) {
    const m = RegExpPrototypeExec(ORIGIN_RE, HostString(url));
    if (m === null)
        return null;
    return ChitinCookies.registrableDomain(StringPrototypeToLowerCase(m[2]));
}

let framesInstalled = false;
// Filled before installGlobal in a child: `parent` and `top` are the parent's stand-in (`top` is
// [LegacyUnforgeable], so it cannot be replaced after the mirror defined it).
let globalReplacements = null;
const FramesWeakRef = globalThis.WeakRef;
const WeakRefDeref = uncurryThis(globalThis.WeakRef.prototype.deref);
let shadowRoots = [];                     // WeakRefs to every shadow root attached in this document
const F = { __proto__: null };            // captured engine functions (before any page script)
const frameIds = new WeakMap();          // iframe element -> id
const frameProxies = new WeakMap();      // iframe element -> stand-in
const framesById = new FramesMap();      // id -> iframe element
let nextFrameId = 1;
let parentProxy = null;
const eventSources = new WeakMap();      // MessageEvent made here -> stand-in source
const eventPorts = new WeakMap();        // MessageEvent made here -> frozen array of engine ports
const bridgedPorts = new WeakMap();      // engine MessagePort -> host MessagePort it talks over
const detachedPorts = new HostWeakSet(); // engine ports transferred away
const portPartners = new WeakMap();      // engine MessagePort -> its entangled twin (from MessageChannel)

const getter = (proto, name) => {
    const d = ObjectGetOwnPropertyDescriptor(proto, name);
    return d && d.get;
};
// Functions that look like the browser's own: method and accessor shorthands have no `prototype` (a plain function has one, which
// `Object.getOwnPropertyNames(fn)` shows and a native's does not), a native name, and the length the interface declares.
function nativeGetter(name, fn) {
    const holder = {
        get [name]() { return ReflectApply(fn, this, []); },
    };
    const g = ObjectGetOwnPropertyDescriptor(holder, name).get;
    WeakSetPrototypeAdd(nativeFunctions, g);
    return g;
}
function nativeMethod(name, fn, length) {
    const m = { [name](...args) { return ReflectApply(fn, this, args); } }[name];
    ObjectDefineProperty(m, 'length', { value: length === undefined ? fn.length : length, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, m);
    return m;
}
function securityError(what) {
    return new F.DOMException('Blocked a frame with origin "' + ownOrigin() + '" from accessing a cross-origin frame' + (what ? ' (' + what + ')' : '') + '.', 'SecurityError');
}
function ownOrigin() {
    try {
        return ReflectApply(F.originGet, G, []);
    } catch {
        return 'null';
    }
}

// --- The cross-origin WindowProxy stand-in -------------------------------------------------------------------
// What Chrome lets a page reach on a cross-origin window (HTML "CrossOriginProperties"): postMessage, window, self,
// frames, parent, top, closed, length, focus, blur, close, location. Anything else throws a SecurityError; then,
// @@toStringTag, @@hasInstance and @@isConcatSpreadable read as undefined.
const FALLBACK_KEYS = { __proto__: null, then: true };
// `extra` (a popup's stand-in, 52-popups.js): { closed(), close(), navigate(url), location() } where location() is null while the
// window is cross-origin, else the same-origin Location stand-in.
function makeRemoteWindow(target, relatives, extra) {
    const members = { __proto__: null };
    const post = makePostMessage(target);
    const noop = (name) => nativeMethod(name, function () {});
    members.postMessage = post;
    members.focus = noop('focus');
    members.blur = noop('blur');
    members.close = extra ? nativeMethod('close', function close() { extra.close(); }, 0) : noop('close');
    const remoteLocation = makeRemoteLocation(extra ? extra.navigate : undefined);
    members.location = remoteLocation;
    let proxy;
    const lookup = (key) => {
        if (key === 'window' || key === 'self' || key === 'frames')
            return proxy;
        if (key === 'parent')
            return relatives.parent();
        if (key === 'top')
            return relatives.top();
        if (key === 'closed')
            return extra ? extra.closed() : false;
        if (key === 'location' && extra) {
            const readable = extra.location();
            return readable !== null ? readable : remoteLocation;
        }
        if (key === 'length')
            return 0;
        return members[key];
    };
    const allowed = (key) => typeof key === 'string' && (members[key] !== undefined || key === 'window' || key === 'self' || key === 'frames' || key === 'parent' || key === 'top' || key === 'closed' || key === 'length');
    const handler = {
        __proto__: null,
        get(t, key) {
            if (allowed(key))
                return lookup(key);
            if (typeof key === 'symbol' ? key === SymbolToStringTag || key === HostSymbol.hasInstance || key === HostSymbol.isConcatSpreadable : FALLBACK_KEYS[key] === true)
                return undefined;
            throw securityError(typeof key === 'string' ? key : '');
        },
        set(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        has(t, key) { return allowed(key); },
        getOwnPropertyDescriptor(t, key) {
            if (!allowed(key))
                throw securityError(typeof key === 'string' ? key : '');
            return { value: lookup(key), writable: false, enumerable: false, configurable: true };
        },
        defineProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        deleteProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        ownKeys() { return ['postMessage', 'focus', 'blur', 'close', 'location', 'window', 'self', 'frames', 'parent', 'top', 'closed', 'length']; },
        getPrototypeOf() { return null; },
        setPrototypeOf() { throw securityError('prototype'); },
        isExtensible() { return true; },
        preventExtensions() { throw securityError('preventExtensions'); },
    };
    proxy = new HostProxy(ObjectCreate(null), handler);
    return proxy;
}

// The cross-origin Location (HTML "CrossOriginProperties" of Location): `replace` and the `href` setter, nothing else
// (reading href, or any other member, is a SecurityError). Navigating the other segment from here is not carried out: a
// child navigating its parent is what Chrome blocks without a user gesture (the case of every frame here: the segment does
// not see the parent's activation), and a parent navigating a cross-site child is not wired to the carapace yet. The URL is
// still checked, so a malformed one throws as in Chrome.
// A popup's stand-in (52-popups.js) passes `navigate`: there the opener does navigate the window it opened.
function makeRemoteLocation(navigate) {
    const check = (url) => {
        const s = HostString(url);
        let resolved = s;
        if (callbacks.HostURL) {
            try {
                resolved = HostString(new callbacks.HostURL(s, ownLocationHref()).href);
            } catch {
                throw new F.DOMException("Failed to execute 'replace' on 'Location': '" + s + "' is not a valid URL.", 'SyntaxError');
            }
        }
        if (navigate !== undefined)
            navigate(resolved);
    };
    const replace = nativeMethod('replace', function replace(url) {
        if (arguments.length === 0)
            throw new HostTypeError("Failed to execute 'replace' on 'Location': 1 argument required, but only 0 present.");
        check(url);
    }, 1);
    const hrefSet = { set href(v) { check(v); } };
    const setter = ObjectGetOwnPropertyDescriptor(hrefSet, 'href').set;
    WeakSetPrototypeAdd(nativeFunctions, setter);
    const allowed = (key) => key === 'replace' || key === 'href';
    const handler = {
        __proto__: null,
        get(t, key) {
            if (key === 'replace')
                return replace;
            if (typeof key === 'symbol' ? key === SymbolToStringTag || key === HostSymbol.hasInstance || key === HostSymbol.isConcatSpreadable : FALLBACK_KEYS[key] === true)
                return undefined;
            throw securityError(typeof key === 'string' ? key : '');
        },
        set(t, key, value) {
            if (key !== 'href')
                throw securityError(typeof key === 'string' ? key : '');
            ReflectApply(setter, undefined, [value]);
            return true;
        },
        has(t, key) { return allowed(key); },
        getOwnPropertyDescriptor(t, key) {
            if (key === 'replace')
                return { value: replace, writable: false, enumerable: false, configurable: true };
            if (key === 'href')
                return { get: undefined, set: setter, enumerable: false, configurable: true };
            throw securityError(typeof key === 'string' ? key : '');
        },
        defineProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        deleteProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        ownKeys() { return ['href', 'replace']; },
        getPrototypeOf() { return null; },
        setPrototypeOf() { throw securityError('prototype'); },
        isExtensible() { return true; },
        preventExtensions() { throw securityError('preventExtensions'); },
    };
    return new HostProxy(ObjectCreate(null), handler);
}
function ownLocationHref() {
    try {
        return HostString(G.location.href);
    } catch {
        return undefined;
    }
}

// postMessage(message, targetOrigin, transfer) or postMessage(message, { targetOrigin, transfer }).
function makePostMessage(target) {
    return nativeMethod('postMessage', function postMessage(message, targetOrigin, transfer) {
        if (arguments.length === 0)
            throw new HostTypeError("Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
        let origin;
        let list;
        if (targetOrigin !== null && typeof targetOrigin === 'object') {
            origin = targetOrigin.targetOrigin === undefined ? '/' : HostString(targetOrigin.targetOrigin);
            list = targetOrigin.transfer;
        } else {
            origin = targetOrigin === undefined ? '/' : HostString(targetOrigin);
            list = transfer;
        }
        if (origin === '/')
            origin = ownOrigin();
        else if (origin !== '*') {
            const o = urlOrigin(origin);
            if (o === null)
                throw new F.DOMException("Failed to execute 'postMessage' on 'Window': Invalid target origin '" + origin + "' in a call to 'postMessage'.", 'SyntaxError');
            origin = o;
        }
        const ports = [];
        const others = [];
        if (list !== undefined && list !== null) {
            const items = ArrayFrom(list);
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item instanceof F.MessagePort)
                    ArrayPrototypePush(ports, exportPort(item));
                else
                    ArrayPrototypePush(others, item);
            }
        }
        const to = target();
        if (to === null || !callbacks.frames || typeof callbacks.frames.post !== 'function')
            return;
        try {
            callbacks.frames.post(to, message, origin, ports, others);
        } catch (e) {
            if (e && e.name === 'DataCloneError')
                throw new F.DOMException(HostString(e.message), 'DataCloneError');
            throw e;
        }
    });
}

// --- MessagePorts across segments ---------------------------------------------------------------------------
// An engine port the page transfers: its twin stays with the page and talks over a new host channel from now on;
// a port that already talks over a host port hands that host port on.
function exportPort(port) {
    if (WeakSetPrototypeHas(detachedPorts, port))
        throw new F.DOMException('Port at index 0 is already neutered.', 'DataCloneError');
    WeakSetPrototypeAdd(detachedPorts, port);
    const existing = WeakMapPrototypeGet(bridgedPorts, port);
    if (existing !== undefined) {
        WeakMapPrototypeDelete(bridgedPorts, port);
        return existing;
    }
    const channel = new callbacks.HostMessageChannel();
    const twin = WeakMapPrototypeGet(portPartners, port);
    if (twin !== undefined)
        bindPort(twin, channel.port1);
    return channel.port2;
}
// A host port that arrived with a message: the page gets an engine port that talks over it.
function importPort(hostPort) {
    const channel = new F.MessageChannel();
    const port = ReflectApply(F.port2Get, channel, []);
    bindPort(port, hostPort);
    return port;
}
function bindPort(port, hostPort) {
    WeakMapPrototypeSet(bridgedPorts, port, hostPort);
    hostPort.onmessage = (e) => {
        if (WeakMapPrototypeGet(bridgedPorts, port) !== hostPort)
            return;
        fireMessage(port, callbacks.streams ? callbacks.streams.inbound(e.data) : e.data, '', null, e.ports);
    };
    if (typeof hostPort.unref === 'function')
        hostPort.unref(); // Node: an open port does not keep a test alive
}

// A trusted MessageEvent on `target` (the window or a port), dispatched by the engine.
function fireMessage(target, data, origin, source, hostPorts) {
    const ports = [];
    if (hostPorts)
        for (let i = 0; i < hostPorts.length; i++)
            ArrayPrototypePush(ports, importPort(hostPorts[i]));
    const event = new F.MessageEvent('message', { data, origin, lastEventId: '' });
    WeakMapPrototypeSet(eventSources, event, source);
    WeakMapPrototypeSet(eventPorts, event, ObjectFreeze(ports));
    const targetCell = target === G ? globalCell : WeakMapPrototypeGet(cellOf, target);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        return X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
}

// A trusted dispatch of an event the page's own constructors made, to an EventTarget of the page (WebSocket's open, message, error
// and close are the browser's events, isTrusted true; the page's own dispatchEvent would mark them untrusted).
api.dispatchTrusted = (target, event) => {
    const targetCell = WeakMapPrototypeGet(cellOf, target);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        return X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
};

// A MessageEvent for a page Worker's message (harness/segment/pagesw-host.js), cheap: made with no init dictionary (converting
// `{ data, ports }` into the engine took most of a Worker-to-page message, 70 of 110 us), its data and frozen ports kept here,
// read back by the getters above exactly as for an event the page constructed with them. `C` is the realm's MessageEvent.
api.messageEvent = (C, data, ports) => {
    const event = new C('message');
    WeakMapPrototypeSet(constructedMessageData, event, { value: data === undefined ? null : data });
    WeakMapPrototypeSet(eventPorts, event, ObjectFreeze(ports || []));
    return event;
};

// HTML "notify about rejected promises": the page's promises are the host V8's, which tracks their rejections and fires
// unhandledrejection / rejectionhandled at the host global after a microtask checkpoint. The host (the segment Worker) hands
// each one here: a trusted PromiseRejectionEvent at the page's window (unhandledrejection cancelable, rejectionhandled not).
// Returns true when the page cancelled it, and the host then cancels its own (no console report, as in Chrome).
api.promiseRejection = (type, promise, reason) => {
    if (type !== 'unhandledrejection' && type !== 'rejectionhandled')
        return false;
    if (stoppedReason !== null || !scriptingOn || globalCell === 0)
        return false;
    const PRE = MapPrototypeGet(classByName, 'PromiseRejectionEvent');
    if (PRE === undefined)
        return false;
    let event;
    try {
        event = new PRE(type, { promise, reason, cancelable: type === 'unhandledrejection' });
    } catch {
        return false;
    }
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, globalCell);
        writeObject(ev, eventCell);
        if (X.ganglion_dispatch_trusted(t, ev) !== 1)
            return false;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
    return event.defaultPrevented === true;
};

// --- Which iframes are remote -------------------------------------------------------------------------------
function remoteUrl(el) {
    let url;
    try {
        url = ReflectApply(F.srcGet, el, []);
    } catch {
        return null;
    }
    if (typeof url !== 'string' || urlOrigin(url) === null)
        return null;
    const own = urlSite(ownOrigin());
    const site = urlSite(url);
    return site !== null && own !== null && site !== own ? url : null;
}
function frameId(el) {
    let id = WeakMapPrototypeGet(frameIds, el);
    if (id === undefined) {
        id = nextFrameId++;
        WeakMapPrototypeSet(frameIds, el, id);
        MapPrototypeSet(framesById, id, el);
    }
    return id;
}
function frameProxy(el) {
    let p = WeakMapPrototypeGet(frameProxies, el);
    if (p === undefined) {
        const id = frameId(el);
        p = makeRemoteWindow(() => (remoteUrl(el) !== null ? id : null), { parent: () => G, top: () => ReflectApply(F.topGet, G, []) });
        WeakMapPrototypeSet(frameProxies, el, p);
    }
    return p;
}

function installFrames() {
    const IFrame = G.HTMLIFrameElement && G.HTMLIFrameElement.prototype;
    if (!IFrame || !G.MessageEvent || !G.MessagePort || !G.MessageChannel)
        return;
    F.DOMException = G.DOMException;
    F.MessageEvent = G.MessageEvent;
    F.MessagePort = G.MessagePort;
    F.MessageChannel = G.MessageChannel;
    F.originGet = getter(G, 'origin');
    F.topGet = getter(G, 'top');
    F.documentGet = getter(G, 'document');
    F.srcGet = getter(IFrame, 'src');
    F.contentWindowGet = getter(IFrame, 'contentWindow');
    F.contentDocumentGet = getter(IFrame, 'contentDocument');
    F.nameGet = getter(IFrame, 'name');
    F.getAttribute = G.Element.prototype.getAttribute;
    F.getElementsByTagName = G.Document.prototype.getElementsByTagName;
    F.collectionLength = getter(G.HTMLCollection.prototype, 'length');
    F.collectionItem = G.HTMLCollection.prototype.item;
    F.getBoundingClientRect = G.Element.prototype.getBoundingClientRect;
    F.fragmentQueryAll = G.DocumentFragment.prototype.querySelectorAll;
    F.nodeListLength = getter(G.NodeList.prototype, 'length');
    F.nodeListItem = G.NodeList.prototype.item;
    F.isConnected = getter(G.Node.prototype, 'isConnected');
    F.parentElement = getter(G.Node.prototype, 'parentElement');
    F.getComputedStyle = G.getComputedStyle;
    F.styleValue = G.CSSStyleDeclaration && G.CSSStyleDeclaration.prototype.getPropertyValue;
    F.scrollHeight = getter(G.Element.prototype, 'scrollHeight');
    F.scrollWidth = getter(G.Element.prototype, 'scrollWidth');
    for (const k of ['clientLeft', 'clientTop', 'clientWidth', 'clientHeight'])
        F[k] = getter(G.Element.prototype, k);
    const RectProto = G.DOMRectReadOnly.prototype;
    F.rectLeft = getter(RectProto, 'left');
    F.rectTop = getter(RectProto, 'top');
    F.sourceGet = getter(G.MessageEvent.prototype, 'source');
    F.Event = G.Event;
    F.readyStateGet = getter(G.Document.prototype, 'readyState');
    F.portsGet = getter(G.MessageEvent.prototype, 'ports');
    F.dataGet = getter(G.MessageEvent.prototype, 'data');
    F.port1Get = getter(G.MessageChannel.prototype, 'port1');
    F.port2Get = getter(G.MessageChannel.prototype, 'port2');
    F.portPost = G.MessagePort.prototype.postMessage;
    const ObjectGetOwnPropertyDescriptorFn = ObjectGetOwnPropertyDescriptor;
    const redefine = (proto, name, get) => {
        const d = ObjectGetOwnPropertyDescriptorFn(proto, name);
        ObjectDefineProperty(proto, name, { get: nativeGetter(name, get), set: d && d.set, enumerable: d ? d.enumerable : true, configurable: true });
    };
    redefine(IFrame, 'contentWindow', function () {
        if (remoteUrl(this) !== null)
            return frameProxy(this);
        return ReflectApply(F.contentWindowGet, this, []);
    });
    redefine(IFrame, 'contentDocument', function () {
        if (remoteUrl(this) !== null)
            return null;
        return ReflectApply(F.contentDocumentGet, this, []);
    });
    redefine(G.MessageEvent.prototype, 'source', function () {
        const s = WeakMapPrototypeGet(eventSources, this);
        return s !== undefined ? s : ReflectApply(F.sourceGet, this, []);
    });
    redefine(G.MessageEvent.prototype, 'ports', function () {
        let p = WeakMapPrototypeGet(eventPorts, this);
        if (p === undefined) {
            // The engine's ports are a plain array (LibWeb: "FIXME: Use a FrozenArray"); the page gets one frozen array per
            // event, the same object on every read, as in Chrome.
            p = ReflectApply(F.portsGet, this, []);
            if (p !== null && typeof p === 'object') {
                ObjectFreeze(p);
                WeakMapPrototypeSet(eventPorts, this, p);
            }
        }
        return p;
    });
    // The data of a message that carried streams (40-bridge.js decodeStreams); the same object every time it is read.
    const decodedData = new WeakMap();
    redefine(G.MessageEvent.prototype, 'data', function () {
        const d = ReflectApply(F.dataGet, this, []);
        if (typeof d !== 'object' || d === null)
            return d;
        const earlier = WeakMapPrototypeGet(decodedData, this);
        if (earlier !== undefined)
            return earlier.value;
        const out = decodeStreams(d);
        if (out !== d)
            WeakMapPrototypeSet(decodedData, this, { value: out });
        return out;
    });
    // Twins of a channel, so a transferred port's twin can be bridged.
    const remember = (channel) => {
        const a = ReflectApply(F.port1Get, channel, []), b = ReflectApply(F.port2Get, channel, []);
        if (WeakMapPrototypeGet(portPartners, a) === undefined) {
            WeakMapPrototypeSet(portPartners, a, b);
            WeakMapPrototypeSet(portPartners, b, a);
        }
    };
    redefine(G.MessageChannel.prototype, 'port1', function () { remember(this); return ReflectApply(F.port1Get, this, []); });
    redefine(G.MessageChannel.prototype, 'port2', function () { remember(this); return ReflectApply(F.port2Get, this, []); });
    const portPost = F.portPost;
    ObjectDefineProperty(G.MessagePort.prototype, 'postMessage', {
        value: nativeMethod('postMessage', function postMessage(message, transfer) {
            if (WeakSetPrototypeHas(detachedPorts, this))
                return;
            const hostPort = WeakMapPrototypeGet(bridgedPorts, this);
            if (hostPort === undefined)
                return ReflectApply(portPost, this, arguments);
            const list = transfer !== null && typeof transfer === 'object' && !ArrayIsArray(transfer) ? transfer.transfer : transfer;
            const moved = [];
            const streamsListed = [];
            if (list !== undefined && list !== null) {
                const items = ArrayFrom(list);
                for (let i = 0; i < items.length; i++) {
                    if (items[i] instanceof F.MessagePort)
                        ArrayPrototypePush(moved, exportPort(items[i]));
                    else if (callbacks.streams && callbacks.streams.isStream(items[i]))
                        ArrayPrototypePush(streamsListed, items[i]);
                    else
                        ArrayPrototypePush(moved, items[i]);
                }
            }
            try {
                let out = message;
                if (callbacks.streams) {
                    const o = callbacks.streams.outbound(message, streamsListed);
                    out = o.message;
                    for (let i = 0; i < o.transfer.length; i++)
                        ArrayPrototypePush(moved, o.transfer[i]);
                }
                hostPort.postMessage(out, moved);
            } catch (e) {
                if (e && e.name === 'DataCloneError')
                    throw new F.DOMException(HostString(e.message), 'DataCloneError');
                throw e;
            }
        }, 1),
        writable: true, enumerable: true, configurable: true,
    });
    // Shadow roots, open and closed: an iframe inside one (Turnstile puts its widget in a closed shadow root) is a
    // cross-site iframe of this document like any other, but document.getElementsByTagName does not reach it.
    const attachShadow = G.Element.prototype.attachShadow;
    if (typeof attachShadow === 'function') {
        ObjectDefineProperty(G.Element.prototype, 'attachShadow', {
            value: nativeMethod('attachShadow', function attachShadow_(init) {
                const root = ReflectApply(attachShadow, this, arguments);
                ArrayPrototypePush(shadowRoots, new FramesWeakRef(root));
                return root;
            }, 1),
            writable: true, enumerable: true, configurable: true,
        });
    }
    if (callbacks.nested)
        parentProxy = makeRemoteWindow(() => 'parent', { parent: () => parentProxy, top: () => parentProxy });
    framesInstalled = true;
}

// Called by enableScripting before the global is installed.
function prepareFrames() {
    if (!callbacks.nested)
        return;
    globalReplacements = { __proto__: null };
    const parentGet = nativeGetter('parent', () => parentProxy);
    const topGet = nativeGetter('top', () => parentProxy);
    globalReplacements.parent = { get: parentGet, set: undefined, enumerable: true, configurable: true };
    globalReplacements.top = { get: topGet, set: undefined, enumerable: true, configurable: false };
}

// Whether a cross-site iframe lets its document use "cross-origin-isolated" (permissions policy, default allowlist 'self': a
// cross-site frame needs allow="cross-origin-isolated"; the same rule as LibWeb's for same-site frames, patch 0070).
function frameAllowedIsolation(el, url) {
    let allow = null;
    try { allow = ReflectApply(F.getAttribute, el, ['allow']); } catch { allow = null; }
    const frameOrigin = urlOrigin(url);
    if (typeof allow === 'string') {
        const directives = StringPrototypeSplit(allow, ';');
        for (let i = 0; i < directives.length; i++) {
            const all = StringPrototypeSplit(StringPrototypeTrim(directives[i]), /\s+/);
            const parts = [];
            for (let j = 0; j < all.length; j++)
                if (all[j] !== '')
                    ArrayPrototypePush(parts, all[j]);
            if (parts.length === 0 || parts[0] !== 'cross-origin-isolated')
                continue;
            if (parts.length === 1)
                return true;
            for (let j = 1; j < parts.length; j++) {
                const t = parts[j];
                if (t === '*' || t === "'src'")
                    return true;
                if (t === "'self'" && frameOrigin === ownOrigin())
                    return true;
                if (urlOrigin(t) !== null && urlOrigin(t) === frameOrigin)
                    return true;
            }
            return false;
        }
    }
    return frameOrigin === ownOrigin();
}

// --- The API for the segment host -------------------------------------------------------------------------
// The cross-site iframes of the document, with their content boxes in viewport CSS pixels.
api.subframes = () => {
    const out = [];
    if (!framesInstalled)
        return out;
    const add = (el) => {
        const url = remoteUrl(el);
        if (url === null || !ReflectApply(F.isConnected, el, []))
            return;
        const rect = ReflectApply(F.getBoundingClientRect, el, []);
        const entry = {
            id: frameId(el), url, name: HostString(ReflectApply(F.nameGet, el, [])),
            coi: { isolated: pageIsolated && frameAllowedIsolation(el, url), coep: api.embedderPolicyOf() },
            x: ReflectApply(F.rectLeft, rect, []) + ReflectApply(F.clientLeft, el, []),
            y: ReflectApply(F.rectTop, rect, []) + ReflectApply(F.clientTop, el, []),
            width: ReflectApply(F.clientWidth, el, []),
            height: ReflectApply(F.clientHeight, el, []),
        };
        // What the frame moves with when the carapace scrolls (threaded scroll, docs/scroll.md B3): nothing under a
        // fixed box; else its scrolling ancestors (their client boxes, which the carapace matches to its scroll nodes'
        // ports) and the viewport. The first 16 frames only (a style read per ancestor per frame).
        if (out.length < 16 && F.getComputedStyle && F.styleValue) {
            const scrollers = [];
            let fixed = false;
            for (let p = el, guard = 0; p && guard < 64; p = ReflectApply(F.parentElement, p, []), guard++) {
                const cs = ReflectApply(F.getComputedStyle, G, [p]);
                const position = ReflectApply(F.styleValue, cs, ['position']);
                if (position === 'fixed' || position === 'sticky') { fixed = position === 'fixed'; if (fixed) break; }
                if (p === el || scrollers.length >= 8) continue;
                const oy = ReflectApply(F.styleValue, cs, ['overflow-y']), ox = ReflectApply(F.styleValue, cs, ['overflow-x']);
                const scrolls = (o) => o === 'auto' || o === 'scroll' || o === 'hidden';
                if ((scrolls(oy) && ReflectApply(F.scrollHeight, p, []) > ReflectApply(F.clientHeight, p, [])) || (scrolls(ox) && ReflectApply(F.scrollWidth, p, []) > ReflectApply(F.clientWidth, p, []))) {
                    const r = ReflectApply(F.getBoundingClientRect, p, []);
                    ArrayPrototypePush(scrollers, [ReflectApply(F.rectLeft, r, []) + ReflectApply(F.clientLeft, p, []), ReflectApply(F.rectTop, r, []) + ReflectApply(F.clientTop, p, []), ReflectApply(F.clientWidth, p, []), ReflectApply(F.clientHeight, p, [])]);
                }
            }
            entry.fixed = fixed;
            entry.scrollers = scrollers;
        }
        ArrayPrototypePush(out, entry);
    };
    const doc = ReflectApply(F.documentGet, G, []);
    const list = ReflectApply(F.getElementsByTagName, doc, ['iframe']);
    const n = ReflectApply(F.collectionLength, list, []);
    for (let i = 0; i < n; i++)
        add(ReflectApply(F.collectionItem, list, [i]));
    const live = [];
    for (let r = 0; r < shadowRoots.length; r++) {
        const root = WeakRefDeref(shadowRoots[r]);
        if (root === undefined)
            continue;
        ArrayPrototypePush(live, shadowRoots[r]);
        const inner = ReflectApply(F.fragmentQueryAll, root, ['iframe']);
        const m = ReflectApply(F.nodeListLength, inner, []);
        for (let i = 0; i < m; i++)
            add(ReflectApply(F.nodeListItem, inner, [i]));
    }
    shadowRoots = live;
    return out;
};

// A message from the other segment, already checked by the carapace: { from: frame id | 'parent', origin, data, ports }.
// The nested segment shown for iframe `id` finished loading its document: the iframe's load event, as a trusted event
// (HTML "iframe load event steps"; the frame is another segment, so the engine never ran them).
api.frameLoaded = (id) => {
    if (!framesInstalled)
        return false;
    const el = MapPrototypeGet(framesById, id);
    if (el === undefined || remoteUrl(el) === null || !ReflectApply(F.isConnected, el, []))
        return false;
    const event = new F.Event('load');
    const targetCell = WeakMapPrototypeGet(cellOf, el);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    let ok = false;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        ok = X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
    api.pump();
    return ok;
};
// Whether the document has finished loading (readyState "complete"): a nested segment tells its parent (the iframe's load).
api.documentComplete = () => {
    try {
        return HostString(ReflectApply(F.readyStateGet, ReflectApply(F.documentGet, G, []), [])) === 'complete';
    } catch {
        return false;
    }
};
// A nested segment's embedder (Host.cpp ganglion_set_embedder): the referrer, the iframe's name, the ancestor origins.
api.setEmbedder = (referrer, name, ancestors) => {
    let text = HostString(referrer) + '\u0000' + HostString(name);
    for (let i = 0; i < ancestors.length; i++)
        text += '\u0000' + HostString(ancestors[i]);
    const ptr = copyInString(text);
    try {
        X.ganglion_set_embedder(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
};
api.deliverMessage = (m) => {
    if (!framesInstalled || !m)
        return false;
    let source;
    if (m.from === 'opener' || (typeof m.from === 'string' && StringPrototypeStartsWith(m.from, 'popup:'))) {
        source = popupMessageSource(m.from);
        if (source === null)
            return false;
    } else if (m.from === 'parent') {
        if (parentProxy === null)
            return false;
        source = parentProxy;
    } else {
        const el = MapPrototypeGet(framesById, m.from);
        if (el === undefined || remoteUrl(el) === null)
            return false;
        source = frameProxy(el);
    }
    const ok = fireMessage(G, m.data, HostString(m.origin), source, m.ports || null);
    api.pump();
    return ok;
};

// ===== glue/engine/52-popups.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: windows a page opens (window.open), for sign-in popups (docs/oauth.md).
// The engine has no second top-level page, so window.open here does what the carapace can do: with a user gesture it
// returns a cross-origin WindowProxy stand-in (50-frames.js makeRemoteWindow) and asks the host to open the window
// (callbacks.popups.open). The carapace decides: a page of the opener's own site runs in a popup segment of that site
// (hidden; its window.opener is a stand-in for this window, and its postMessage reaches this page through the carapace,
// origin stamped and checked as for frames); an identity provider's page goes to the user's real browser (RFC 8252), and
// the address the provider returns to, pasted back by the user, becomes the popup segment's page. The stand-in's
// `closed` and, while the popup shows a page of this origin, its `location` follow what the carapace reports (popupState).
// Without a gesture the engine's own window.open runs (Chrome's popup blocker: null).

const StringPrototypeStartsWith = uncurryThis(HostString.prototype.startsWith);
const PopupMap = globalThis.Map;
const popups = new PopupMap();           // id -> { id, name, closed, url, proxy }
const popupList = [];                    // the same entries, in order (no Map iteration: page code shares the realm's prototypes)
let nextPopupId = 1;
let openerProxy = null;                  // in a popup segment: the stand-in for the window that opened it
let openerOverride;                      // `window.opener = x` (a replaceable attribute)
let openerOverridden = false;

// The MessageEvent source for a message the carapace delivers from `opener` or `popup:<id>` (50-frames.js deliverMessage).
function popupMessageSource(from) {
    if (from === 'opener')
        return openerProxy;
    const id = +StringPrototypeSlice(from, 6);
    const p = MapPrototypeGet(popups, id);
    return p === undefined || p.closed ? null : p.proxy;
}

// The features string's noopener / noreferrer (HTML "tokenize the features argument" and "check if a window feature is set").
function featureSet(features, name) {
    const parts = StringPrototypeSplit(StringPrototypeToLowerCase(HostString(features)), new HostRegExp('[\\s,]+'));
    for (let i = 0; i < parts.length; i++) {
        const eq = StringPrototypeSplit(parts[i], '=');
        if (StringPrototypeTrim(eq[0]) !== name)
            continue;
        if (eq.length === 1)
            return true;
        const v = StringPrototypeTrim(eq[1]);
        return v === '' || v === 'yes' || v === 'true' || (v !== '' && +v !== 0 && v === v);
    }
    return false;
}

// A same-origin popup's Location, read-only but for href (what MSAL-style popup flows read: href, hash, search).
function makeReadableLocation(href, navigate) {
    let u;
    try {
        u = new callbacks.HostURL(href);
    } catch {
        return null;
    }
    const fields = ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
    const loc = ObjectCreate(null);
    for (let i = 0; i < fields.length; i++) {
        const k = fields[i];
        const value = HostString(u[k]);
        const holder = k === 'href'
            ? { get href() { return value; }, set href(v) { navigate(HostString(new callbacks.HostURL(HostString(v), href).href)); } }
            : { get [k]() { return value; } };
        const d = ObjectGetOwnPropertyDescriptor(holder, k);
        WeakSetPrototypeAdd(nativeFunctions, d.get);
        if (d.set)
            WeakSetPrototypeAdd(nativeFunctions, d.set);
        ObjectDefineProperty(loc, k, { get: d.get, set: d.set, enumerable: true, configurable: false });
    }
    const assign = (name) => nativeMethod(name, function (url) { navigate(HostString(new callbacks.HostURL(HostString(url), href).href)); }, 1);
    ObjectDefineProperty(loc, 'assign', { value: assign('assign'), enumerable: true });
    ObjectDefineProperty(loc, 'replace', { value: assign('replace'), enumerable: true });
    ObjectDefineProperty(loc, 'toString', { value: nativeMethod('toString', function () { return HostString(u.href); }, 0), enumerable: true });
    return ObjectFreeze(loc);
}

function makePopup(id, name) {
    const p = { id, name, closed: false, url: '', proxy: null, readable: null, readableFor: '' };
    const navigate = (url) => {
        if (!p.closed)
            callbacks.popups.navigate(id, url);
    };
    p.proxy = makeRemoteWindow(() => (p.closed ? null : 'popup:' + id), { parent: () => p.proxy, top: () => p.proxy }, {
        closed: () => p.closed,
        close: () => {
            if (p.closed)
                return;
            p.closed = true;
            callbacks.popups.close(id);
        },
        navigate,
        location: () => {
            if (p.closed || p.url === '' || urlOrigin(p.url) !== ownOrigin())
                return null;
            if (p.readableFor !== p.url) {
                p.readable = makeReadableLocation(p.url, navigate);
                p.readableFor = p.url;
            }
            return p.readable;
        },
    });
    MapPrototypeSet(popups, id, p);
    ArrayPrototypePush(popupList, p);
    return p;
}

function hasTransientActivation() {
    if (!F.navigatorGet || !F.userActivationGet || !F.isActiveGet)
        return false;
    try {
        const ua = ReflectApply(F.userActivationGet, ReflectApply(F.navigatorGet, G, []), []);
        return ua !== null && ua !== undefined && ReflectApply(F.isActiveGet, ua, []) === true;
    } catch {
        return false;
    }
}

// Before the global is installed (40-bridge.js enableScripting): `open` (and in a popup segment `opener` and `close`) are
// replacements of the engine's members, so the page's global has them from its first script (under Node's vm too, where the
// page's global is not the glue's object).
function preparePopups() {
    if (!callbacks.popups || !callbacks.HostURL)
        return;
    if (globalReplacements === null)
        globalReplacements = { __proto__: null };
    globalReplacements.open = (defineEngineMember) => {
        const holder = ObjectCreate(null);
        defineEngineMember(holder);
        const openDesc = ObjectGetOwnPropertyDescriptor(holder, 'open');
        if (openDesc === undefined || typeof openDesc.value !== 'function')
            return openDesc;
        const engineOpen = openDesc.value;
        const open = nativeMethod('open', function open(url, target, features) {
            const name = target === undefined ? '_blank' : HostString(target);
            const lower = StringPrototypeToLowerCase(name);
            // A window of this page's own (the page itself, its parent or top): the engine navigates it, as before.
            if (lower === '_self' || lower === '_parent' || lower === '_top')
                return ReflectApply(engineOpen, this, arguments);
            let resolved = 'about:blank';
            const given = url === undefined ? '' : HostString(url);
            if (given !== '') {
                try {
                    resolved = HostString(new callbacks.HostURL(given, ownLocationHref()).href);
                } catch {
                    throw new F.DOMException("Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + given + "'.", 'SyntaxError');
                }
            }
            // A named window this page already opened: navigated, and the same WindowProxy returned.
            if (lower !== '_blank' && name !== '') {
                for (let i = 0; i < popupList.length; i++) {
                    const p = popupList[i];
                    if (!p.closed && p.name === name) {
                        if (resolved !== 'about:blank')
                            callbacks.popups.navigate(p.id, resolved);
                        return p.proxy;
                    }
                }
            }
            if (!hasTransientActivation())
                return ReflectApply(engineOpen, this, arguments); // the popup blocker: null, as in Chrome
            if (resolved !== 'about:blank' && !StringPrototypeStartsWith(resolved, 'https:') && !StringPrototypeStartsWith(resolved, 'http:'))
                return null; // javascript:, data:, blob: windows are not opened (docs/oauth.md)
            const noopener = features !== undefined && (featureSet(features, 'noopener') || featureSet(features, 'noreferrer'));
            const id = nextPopupId++;
            const p = makePopup(id, lower === '_blank' ? '' : name);
            callbacks.popups.open(id, resolved === 'about:blank' ? '' : resolved, noopener);
            return noopener ? null : p.proxy;
        }, 0);
        return { value: open, writable: openDesc.writable, enumerable: openDesc.enumerable, configurable: openDesc.configurable };
    };
    if (callbacks.opener !== true)
        return;
    // This segment is a popup: `opener` is the opener's stand-in (replaceable, as in Chrome), and close() closes it.
    openerProxy = makeRemoteWindow(() => 'opener', { parent: () => openerProxy, top: () => openerProxy });
    const holder = {
        get opener() { return openerOverridden ? openerOverride : openerProxy; },
        set opener(v) { openerOverridden = true; openerOverride = v; },
    };
    const d = ObjectGetOwnPropertyDescriptor(holder, 'opener');
    WeakSetPrototypeAdd(nativeFunctions, d.get);
    WeakSetPrototypeAdd(nativeFunctions, d.set);
    globalReplacements.opener = { get: d.get, set: d.set, enumerable: true, configurable: true };
    const close = nativeMethod('close', function close() { callbacks.popups.selfClose(); }, 0);
    globalReplacements.close = { value: close, writable: true, enumerable: true, configurable: true };
}

// After the global is installed: what the replacements read at call time.
function installPopups() {
    F.navigatorGet = getter(G, 'navigator');
    F.userActivationGet = G.Navigator && getter(G.Navigator.prototype, 'userActivation');
    F.isActiveGet = G.UserActivation && getter(G.UserActivation.prototype, 'isActive');
}

// The carapace's word on a popup this page opened: { id, closed, url } (url: the page it shows, '' while none).
api.popupState = (m) => {
    const p = m && MapPrototypeGet(popups, m.id);
    if (p === undefined || p.closed)
        return false;
    if (typeof m.url === 'string')
        p.url = m.url;
    if (m.closed === true)
        p.closed = true;
    return true;
};

// ===== glue/engine/55-media.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: media decoding for the engine's media server (engine/platform/Media.cpp) on the host's
// WebCodecs (VideoDecoder, AudioDecoder; a dedicated Worker has both). Encoded samples come out of the engine,
// decoded planes go back in. The WebCodecs constructors are captured when the glue loads, before any page script.
// A host without WebCodecs (Node tests) passes callbacks.createMediaDecoder and callbacks.mediaCodecs instead.
//
// Audio: decoded PCM (planar float) goes to callbacks.audio, the segment host's output (in the segment Worker: a port
// to the carapace's AudioWorklet, harness/carapace/audio-worklet.js), never back into the engine; the engine hears
// how far it was decoded and, from the output, the media time being heard, which then drives its clock.
//   callbacks.audio = { open(id, onProgress(playedUs, queuedUs, flags)), write(id, timestampUs, sampleRate, planes),
//                       control(id, { playing, volume, rate, syncUs }), close(id) }

const HostVideoDecoder = globalThis.VideoDecoder;
const HostAudioDecoder = globalThis.AudioDecoder;
const HostEncodedVideoChunk = globalThis.EncodedVideoChunk;
const HostEncodedAudioChunk = globalThis.EncodedAudioChunk;
const VideoDecoderPrototypeConfigure = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.configure) : null;
const VideoDecoderPrototypeDecode = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.decode) : null;
const VideoDecoderPrototypeFlush = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.flush) : null;
const VideoDecoderPrototypeClose = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.close) : null;
const VideoDecoderIsConfigSupported = HostVideoDecoder ? HostVideoDecoder.isConfigSupported : null;
const AudioDecoderIsConfigSupported = HostAudioDecoder ? HostAudioDecoder.isConfigSupported : null;
const HostVideoFrame = globalThis.VideoFrame;
const VideoFramePrototypeCopyTo = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.copyTo) : null;
const VideoFramePrototypeAllocationSize = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.allocationSize) : null;
const VideoFramePrototypeClose = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.close) : null;
const VideoFrameGetFormat = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'format').get) : null;
const VideoFrameGetTimestamp = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'timestamp').get) : null;
const VideoFrameGetDuration = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'duration').get) : null;
const VideoFrameGetVisibleRect = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'visibleRect').get) : null;
const FunctionPrototypeCall = uncurryThis(HostFunction.prototype.call);
const HostUint8ArrayMedia = globalThis.Uint8Array;
const HostFloat32ArrayMedia = globalThis.Float32Array;
const AudioDecoderPrototypeConfigure = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.configure) : null;
const AudioDecoderPrototypeDecode = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.decode) : null;
const AudioDecoderPrototypeFlush = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.flush) : null;
const AudioDecoderPrototypeClose = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.close) : null;
const HostAudioData = globalThis.AudioData;
const audioDataGetter = (name) => HostAudioData ? uncurryThis(Object.getOwnPropertyDescriptor(HostAudioData.prototype, name).get) : null;
const AudioDataGetFrames = audioDataGetter('numberOfFrames');
const AudioDataGetChannels = audioDataGetter('numberOfChannels');
const AudioDataGetSampleRate = audioDataGetter('sampleRate');
const AudioDataGetTimestamp = audioDataGetter('timestamp');
const AudioDataPrototypeCopyTo = HostAudioData ? uncurryThis(HostAudioData.prototype.copyTo) : null;
const AudioDataPrototypeClose = HostAudioData ? uncurryThis(HostAudioData.prototype.close) : null;

const mediaDecoders = { __proto__: null };

// Video on the host (docs/youtube.md): with the GPU compositor a decoded frame stays here as an ImageBitmap (its
// VideoFrame closed at once, so a hardware decoder gets its buffer back) and the engine gets a handle; the carapace
// draws the bitmap where the engine's video layer is. The engine asks for the pixels (hostFramePlanes) only when it
// draws the frame itself, and releases the handle when nothing holds the frame.
const HostCreateImageBitmap = typeof createImageBitmap === 'function' ? createImageBitmap : null;
const HostOffscreenCanvasMedia = typeof OffscreenCanvas === 'function' ? OffscreenCanvas : null;
const hostFrames = new HostMap();
let nextHostFrame = 1;
let readbackCanvas = null;
function hostFramesWanted() {
    return !!HostCreateImageBitmap && !!HostOffscreenCanvasMedia && !callbacks.createMediaDecoder && api.compositor() === 'gpu';
}
// The bitmap to show for a host frame: its display copy, handed over once (transferred to the carapace); a frame shown
// again (a new layer) gets a copy of the kept one.
api.takeHostVideoFrame = (handle) => {
    const f = MapPrototypeGet(hostFrames, handle);
    if (f === undefined)
        return null;
    const show = f.show;
    f.show = null;
    return show ? [show, true] : [f.keep, false]; // [bitmap, whether it may be transferred]
};
api.hostVideoFrameCount = () => hostFrames.size;

// The probe's codec strings, one per family the engine asks about (Media.cpp family_of).
const MEDIA_PROBES = [
    ['vp8', 'video', { codec: 'vp8' }],
    ['vp9', 'video', { codec: 'vp09.00.10.08' }],
    ['av1', 'video', { codec: 'av01.0.04M.08' }],
    ['h264', 'video', { codec: 'avc1.42E01E' }],
    ['h265', 'video', { codec: 'hev1.1.6.L93.B0' }],
    ['opus', 'audio', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    ['vorbis', 'audio', { codec: 'vorbis', sampleRate: 48000, numberOfChannels: 2 }],
    ['aac', 'audio', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }],
    ['flac', 'audio', { codec: 'flac', sampleRate: 48000, numberOfChannels: 2 }],
    ['mp3', 'audio', { codec: 'mp3', sampleRate: 48000, numberOfChannels: 2 }],
];

// Asks the host which codec families it decodes and tells the engine (canPlayType, isTypeSupported). Resolves
// once the engine knows; the segment host awaits it before the first page.
api.probeMediaCodecs = async () => {
    let families = [];
    if (callbacks.mediaCodecs) {
        families = callbacks.mediaCodecs;
    } else {
        for (let i = 0; i < MEDIA_PROBES.length; i++) {
            const probe = MEDIA_PROBES[i];
            const check = probe[1] === 'video' ? VideoDecoderIsConfigSupported : AudioDecoderIsConfigSupported;
            if (!check)
                continue;
            try {
                const result = await FunctionPrototypeCall(check, probe[1] === 'video' ? HostVideoDecoder : HostAudioDecoder, probe[2]);
                if (result && result.supported)
                    families[families.length] = probe[0];
            } catch (e) {
            }
        }
    }
    let text = '';
    for (let i = 0; i < families.length; i++)
        text += (i ? '\n' : '') + families[i];
    const ptr = copyInString(text);
    try {
        X.ganglion_media_set_codec_support(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
    return families;
};

// Planes in the layout the engine takes: Y, U, V one after another, tightly packed; chroma 0 4:2:0, 1 4:2:2, 2 4:4:4.
const VIDEO_FORMATS = { __proto__: null, I420: [0, 8, 3], I420A: [0, 8, 3], I422: [1, 8, 3], I444: [2, 8, 3], I420P10: [0, 10, 3], I422P10: [1, 10, 3], I444P10: [2, 10, 3], NV12: [0, 8, 2] };

async function planesOfVideoFrame(frame) {
    const format = VideoFrameGetFormat(frame);
    const rect = VideoFrameGetVisibleRect(frame);
    const width = rect.width, height = rect.height;
    const info = VIDEO_FORMATS[format];
    if (!info)
        throw new HostError('unsupported frame format ' + format);
    const chroma = info[0], bitDepth = info[1];
    const bytesPerSample = bitDepth > 8 ? 2 : 1;
    const cw = chroma === 2 ? width : (width + 1) >> 1;
    const ch = chroma === 0 ? (height + 1) >> 1 : height;
    const ySize = width * height * bytesPerSample;
    const cSize = cw * ch * bytesPerSample;
    const out = new HostUint8ArrayMedia(ySize + 2 * cSize);
    if (info[2] === 3) {
        // Ask for exactly our layout (the alpha plane of I420A, if any, after it in a scratch buffer).
        const layout = [{ offset: 0, stride: width * bytesPerSample }, { offset: ySize, stride: cw * bytesPerSample }, { offset: ySize + cSize, stride: cw * bytesPerSample }];
        if (format === 'I420A') {
            const scratch = new HostUint8ArrayMedia(ySize * 2 + 2 * cSize);
            layout[3] = { offset: ySize + 2 * cSize, stride: width };
            await VideoFramePrototypeCopyTo(frame, scratch, { layout });
            for (let i = 0; i < out.length; i++)
                out[i] = scratch[i];
        } else {
            await VideoFramePrototypeCopyTo(frame, out, { layout });
        }
    } else {
        // NV12: interleaved UV, split here.
        const scratch = new HostUint8ArrayMedia(ySize + 2 * cSize);
        await VideoFramePrototypeCopyTo(frame, scratch, { layout: [{ offset: 0, stride: width }, { offset: ySize, stride: cw * 2 }] });
        for (let i = 0; i < ySize; i++)
            out[i] = scratch[i];
        for (let i = 0; i < cSize; i++) {
            out[ySize + i] = scratch[ySize + 2 * i];
            out[ySize + cSize + i] = scratch[ySize + 2 * i + 1];
        }
    }
    return { width, height, chroma, bitDepth, planes: out };
}

// A WebCodecs AudioDecoder: each AudioData leaves as planar float, one Float32Array per channel.
function webCodecsAudioDecoder(config, sink) {
    if (!HostAudioDecoder)
        return null;
    const decoder = new HostAudioDecoder({
        output: (data) => {
            try {
                const frames = AudioDataGetFrames(data), channels = AudioDataGetChannels(data);
                const planes = [];
                for (let c = 0; c < channels; c++) {
                    const plane = new HostFloat32ArrayMedia(frames);
                    AudioDataPrototypeCopyTo(data, plane, { planeIndex: c, format: 'f32-planar' });
                    planes[c] = plane;
                }
                sink.audio({ __proto__: null, timestamp: AudioDataGetTimestamp(data), sampleRate: AudioDataGetSampleRate(data), planes });
            } catch (e) {
                sink.error('' + e);
            } finally {
                AudioDataPrototypeClose(data);
            }
        },
        error: (e) => sink.error('' + (e && e.message || e) + ' (' + options.codec + ', ' + options.sampleRate + ' Hz, ' + options.numberOfChannels + ' channels, description ' + (options.description ? options.description.length + ' bytes' : 'none') + ')'),
    });
    const options = { codec: config.codec, sampleRate: config.sampleRate || 48000, numberOfChannels: config.channels || 2 };
    if (config.description && config.description.length)
        options.description = config.description;
    // An Opus stream's own header (OpusHead) has its channel count, and Opus decodes at 48 kHz: Chrome refuses a
    // configuration whose channel count differs from the header's (a container may say otherwise; LibMedia's track
    // gives 2 for the mono test clip).
    const d = options.description;
    if (config.codec === 'opus' && d && d.length >= 19 && d[0] === 0x4f && d[1] === 0x70 && d[2] === 0x75 && d[3] === 0x73 && d[9] > 0) {
        options.numberOfChannels = d[9];
        options.sampleRate = 48000;
    }
    AudioDecoderPrototypeConfigure(decoder, options);
    return {
        decode: (chunk) => AudioDecoderPrototypeDecode(decoder, new HostEncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, duration: chunk.duration || undefined, data: chunk.data })),
        flush: () => AudioDecoderPrototypeFlush(decoder),
        close: () => { try { AudioDecoderPrototypeClose(decoder); } catch (e) { } },
    };
}

// A WebCodecs decoder behind the interface the engine's imports use (and a fake one in tests implements).
function webCodecsDecoder(config, sink) {
    if (config.kind === 1)
        return webCodecsAudioDecoder(config, sink);
    if (config.kind !== 0 || !HostVideoDecoder)
        return null;
    // Outputs are copied out in order: each waits for the one before it.
    let chain = HostPromise.resolve();
    const decoder = new HostVideoDecoder({
        output: (frame) => {
            const timestamp = VideoFrameGetTimestamp(frame);
            const duration = VideoFrameGetDuration(frame) || 0;
            if (hostFramesWanted() && sink.hostFrame) {
                const rect = VideoFrameGetVisibleRect(frame);
                const width = rect.width, height = rect.height;
                // Two bitmaps: one the engine may read back (drawImage of the video, WebGL uploads), one transferred to
                // the carapace (a structured clone of an ImageBitmap copies its pixels on this thread: ~5 ms a 1080p frame).
                chain = PromisePrototypeThen(chain, () => PromisePrototypeThen(HostCreateImageBitmap(frame, { resizeWidth: width, resizeHeight: height }), (keep) => {
                    VideoFramePrototypeClose(frame);
                    return PromisePrototypeThen(HostCreateImageBitmap(keep), (show) => sink.hostFrame(keep, show, timestamp, duration, width, height), (e) => { keep.close(); sink.error('' + e); });
                }, (e) => {
                    VideoFramePrototypeClose(frame);
                    sink.error('' + e);
                }));
                return;
            }
            chain = PromisePrototypeThen(chain, () => PromisePrototypeThen(planesOfVideoFrame(frame), (p) => {
                VideoFramePrototypeClose(frame);
                p.timestamp = timestamp;
                p.duration = duration;
                sink.frame(p);
            }, (e) => {
                VideoFramePrototypeClose(frame);
                sink.error('' + e);
            }));
        },
        error: (e) => sink.error('' + (e && e.message || e)),
    });
    // optimizeForLatency: each frame comes out as soon as it is decoded; otherwise the decoder holds several back, and the
    // few frames the engine keeps ahead (Media.cpp) run out after a seek.
    const options = { codec: config.codec, optimizeForLatency: true };
    if (config.description && config.description.length)
        options.description = config.description;
    if (config.width)
        options.codedWidth = config.width;
    if (config.height)
        options.codedHeight = config.height;
    VideoDecoderPrototypeConfigure(decoder, options);
    return {
        decode: (chunk) => VideoDecoderPrototypeDecode(decoder, new HostEncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.timestamp, duration: chunk.duration || undefined, data: chunk.data })),
        flush: () => PromisePrototypeThen(VideoDecoderPrototypeFlush(decoder), () => chain),
        close: () => { try { VideoDecoderPrototypeClose(decoder); } catch (e) { } },
    };
}

const webAudioStreams = { __proto__: null };
let nextWebAudioStream = 0x40000000;
function addMediaImports(env) {
    env.ganglion_host_media_decoder_create = (id, kind, codecPtr, codecLen, descPtr, descLen, width, height, sampleRate, channels) => {
        const config = { __proto__: null, kind, codec: bytesToString(codecPtr, codecLen), description: copyOutBytes(descPtr, descLen), width, height, sampleRate, channels };
        const sink = {
            __proto__: null,
            frame: (p) => {
                if (!mediaDecoders[id])
                    return;
                const ptr = copyIn(p.planes);
                try {
                    X.ganglion_media_video_frame(id, p.timestamp, p.duration, p.width, p.height, p.chroma, p.bitDepth, ptr, p.planes.length);
                } finally {
                    X.ganglion_free(ptr);
                }
                api.pump();
            },
            hostFrame: (keep, show, timestamp, duration, width, height) => {
                if (!mediaDecoders[id]) {
                    keep.close();
                    show.close();
                    return;
                }
                const handle = nextHostFrame++;
                MapPrototypeSet(hostFrames, handle, { __proto__: null, keep, show });
                X.ganglion_media_video_frame_host(id, timestamp, duration, width, height, handle);
                api.pump();
            },
            audio: (a) => {
                if (!mediaDecoders[id])
                    return;
                const frames = a.planes.length ? a.planes[0].length : 0;
                const end = a.timestamp + (frames * 1e6) / a.sampleRate;
                if (callbacks.audio)
                    callbacks.audio.write(id, a.timestamp, a.sampleRate, a.planes);
                X.ganglion_media_audio_decoded(id, end);
                api.pump();
            },
            error: (message) => {
                if (!mediaDecoders[id])
                    return;
                const ptr = copyInString(message);
                try {
                    X.ganglion_media_decoder_error(id, ptr, TextEncoderPrototypeEncode(encoderUtf8, message).length);
                } finally {
                    X.ganglion_free(ptr);
                }
                api.pump();
            },
        };
        let decoder = null;
        try {
            decoder = callbacks.createMediaDecoder ? callbacks.createMediaDecoder(config, sink) : webCodecsDecoder(config, sink);
        } catch (e) {
            engineLog('ganglion: media: the host refused the decoder for ' + config.codec + ': ' + e);
        }
        if (!decoder)
            return 0;
        mediaDecoders[id] = decoder;
        if (kind === 1 && callbacks.audio) {
            callbacks.audio.open(id, (playedUs, queuedUs, flags) => {
                if (!mediaDecoders[id])
                    return;
                X.ganglion_media_audio_progress(id, playedUs, queuedUs, flags);
                api.pump();
            });
        }
        return 1;
    };
    // Web Audio's output (an AudioContext's destination): LibMedia's null stream pulls the graph at the output's pace and
    // hands each period here; it goes to the same host output as media audio (callbacks.audio), a stream of its own whose
    // timeline is the frames written so far. Ids from 0x40000000 never meet a media decoder's.
    env.ganglion_host_webaudio_open = (sampleRate, channels) => {
        if (!callbacks.audio || channels < 1 || channels > 8)
            return 0;
        const id = nextWebAudioStream++;
        webAudioStreams[id] = { __proto__: null, sampleRate, channels, frames: 0 };
        callbacks.audio.open(id, () => {});
        return id;
    };
    env.ganglion_host_webaudio_write = (id, ptr, frames) => {
        const s = webAudioStreams[id];
        if (!s || !callbacks.audio || frames <= 0)
            return;
        views();
        const src = new HostFloat32ArrayMedia(u8.buffer, ptr, frames * s.channels);
        const planes = [];
        for (let c = 0; c < s.channels; c++) {
            const plane = new HostFloat32ArrayMedia(frames);
            for (let i = 0, j = c; i < frames; i++, j += s.channels)
                plane[i] = src[j];
            planes[c] = plane;
        }
        const t = (s.frames * 1e6) / s.sampleRate;
        s.frames += frames;
        callbacks.audio.write(id, t, s.sampleRate, planes);
    };
    env.ganglion_host_webaudio_control = (id, playing, volume) => {
        if (webAudioStreams[id] && callbacks.audio)
            callbacks.audio.control(id, { __proto__: null, playing: !!playing, volume, rate: 1, syncUs: null });
    };
    env.ganglion_host_webaudio_close = (id) => {
        if (!webAudioStreams[id])
            return;
        delete webAudioStreams[id];
        if (callbacks.audio)
            callbacks.audio.close(id);
    };
    env.ganglion_host_media_audio_control = (id, playing, volume, rate, syncUs) => {
        if (mediaDecoders[id] && callbacks.audio)
            callbacks.audio.control(id, { __proto__: null, playing: !!playing, volume, rate, syncUs: syncUs >= 0 ? syncUs : null });
    };
    env.ganglion_host_media_frame_release = (handle) => {
        const f = MapPrototypeGet(hostFrames, handle);
        if (f === undefined)
            return;
        MapPrototypeDelete(hostFrames, handle);
        f.keep.close();
        if (f.show)
            f.show.close();
    };
    // The frame's pixels into three planes (G, B, R: a 4:4:4 frame with the Identity matrix, Media.cpp FrameSink).
    env.ganglion_host_media_frame_planes = (handle, width, height, gPtr, bPtr, rPtr) => {
        const f = MapPrototypeGet(hostFrames, handle);
        const bitmap = f && f.keep;
        if (!bitmap || !(bitmap.width > 0) || !HostOffscreenCanvasMedia)
            return 0;
        if (!readbackCanvas || readbackCanvas.width !== width || readbackCanvas.height !== height)
            readbackCanvas = new HostOffscreenCanvasMedia(width, height);
        const g = readbackCanvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(bitmap, 0, 0, width, height);
        const rgba = g.getImageData(0, 0, width, height).data;
        views();
        const n = width * height;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            u8[gPtr + i] = rgba[j + 1];
            u8[bPtr + i] = rgba[j + 2];
            u8[rPtr + i] = rgba[j];
        }
        return 1;
    };
    env.ganglion_host_media_decode = (id, ptr, len, timestamp, duration, key) => {
        const decoder = mediaDecoders[id];
        if (!decoder)
            return;
        const data = copyOutBytes(ptr, len);
        try {
            decoder.decode({ __proto__: null, data, timestamp, duration, key: !!key });
        } catch (e) {
            hostSetTimeout(() => { if (mediaDecoders[id]) { const p = copyInString('' + e); try { X.ganglion_media_decoder_error(id, p, ('' + e).length); } finally { X.ganglion_free(p); } api.pump(); } }, 0);
        }
    };
    env.ganglion_host_media_decoder_flush = (id) => {
        const decoder = mediaDecoders[id];
        if (!decoder)
            return;
        PromisePrototypeThen(HostPromise.resolve(decoder.flush()), () => {
            if (!mediaDecoders[id])
                return;
            X.ganglion_media_decoder_flushed(id);
            api.pump();
        }, () => {});
    };
    env.ganglion_host_media_decoder_close = (id) => {
        const decoder = mediaDecoders[id];
        delete mediaDecoders[id];
        if (decoder) {
            decoder.close();
            if (callbacks.audio)
                callbacks.audio.close(id);
        }
    };
}

// ===== glue/engine/55-realms.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: a script realm per same-site child navigable (M6, docs/architecture.md "Frame realms").
// The segment Worker's V8 has one global, the principal window's. A same-site frame's window gets a global of its own
// here: an ordinary object that the mirror fills from the frame's engine Window (its prototypes are the frame realm's,
// so its interface objects are its own), behind a WindowProxy that stays the same object across the frame's
// navigations. The frame's classic scripts run against it through a fixed wrapper:
//
//   (function (__chitin_r) { with (__chitin_r.g) with (__chitin_r.w) with (__chitin_r.l) { <prologue> <script> } })
//
// `l` holds the frame's global lexical declarations (top-level let/const/class shared by its scripts), `w` is the frame's
// global object and `g` a guard that hides the principal window's own names from the frame (a read gives undefined
// instead of the parent's value; a sloppy assignment lands on the frame's global). The prologue, on the script's first
// line, registers the script's top-level function and lexical declarations with the realm; its top-level `var`s are
// created on the frame's global before it runs. A strict script ("use strict" directive) runs in a strict function
// inside the wrapper (a `with` is not allowed in strict code), its top-level vars registered as live accessors.
// The ECMAScript built-ins (Object, Array, Promise...) are the Worker's, shared by every realm of the segment: the known
// residue (docs/surface.md). The scanner below finds the declarations without a full parser: it tracks strings,
// comments, template literals, regular expression literals and brackets, and descends only into statement blocks.

const RealmsMap = globalThis.Map;
const RealmsSet = globalThis.Set;
const RealmsMapGet = uncurryThis(RealmsMap.prototype.get);
const RealmsMapSet = uncurryThis(RealmsMap.prototype.set);
const RealmsMapHas = uncurryThis(RealmsMap.prototype.has);
const RealmsMapDelete = uncurryThis(RealmsMap.prototype.delete);
const RealmsSetHas = uncurryThis(RealmsSet.prototype.has);
const RealmsSetAdd = uncurryThis(RealmsSet.prototype.add);
const RealmsSetDelete = uncurryThis(RealmsSet.prototype.delete);
const ArrayFromRealms = Array.from;
const RealmsPush = uncurryThis(Array.prototype.push);
const RealmsJoin = uncurryThis(Array.prototype.join);
const RealmsArrayIncludes = uncurryThis(Array.prototype.includes);
const RealmsSlice = uncurryThis(HostString.prototype.slice);
const RealmsJSONStringify = globalThis.JSON.stringify;
const RealmsSyntaxError = globalThis.SyntaxError;
const RealmsProxy = globalThis.Proxy;

// --- The declaration scanner ---------------------------------------------------------------------------------------
const KW_BEFORE_REGEX = new RealmsSet(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const BLOCK_HEADS = new RealmsSet(['if', 'for', 'while', 'with', 'switch', 'catch']);
const BLOCK_KEYWORDS = new RealmsSet(['else', 'try', 'finally', 'do']);

function isIdStart(c) {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c > 127 || c === 92;
}
function isIdPart(c) {
    return isIdStart(c) || (c >= 48 && c <= 57);
}

// Tokens: { t: 'id' | 'p' (punctuator) | 'str' | 'num' | 're' | 'tpl', v, s (start offset), nl (a line break before) }.
function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    let nl = false;
    const tplDepth = []; // brace depth at each open ${ of a template literal
    let braces = 0;
    const last = () => out.length ? out[out.length - 1] : null;
    const regexAllowed = () => {
        const p = last();
        if (p === null)
            return true;
        if (p.t === 'num' || p.t === 'str' || p.t === 're' || p.t === 'tpl')
            return false;
        if (p.t === 'id')
            return RealmsSetHas(KW_BEFORE_REGEX, p.v);
        return p.v !== ')' && p.v !== ']' && p.v !== '}' && p.v !== '++' && p.v !== '--';
    };
    const readTemplate = (start) => {
        // From just after ` or }: to the closing ` or to ${.
        let j = start;
        while (j < n) {
            const c = StringPrototypeCharCodeAt(src, j);
            if (c === 92) { j += 2; continue; }
            if (c === 96) return { end: j + 1, open: false };
            if (c === 36 && StringPrototypeCharCodeAt(src, j + 1) === 123) return { end: j + 2, open: true };
            j++;
        }
        return { end: n, open: false };
    };
    while (i < n) {
        const c = StringPrototypeCharCodeAt(src, i);
        if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { nl = true; i++; continue; }
        if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xA0 || c === 0xFEFF) { i++; continue; }
        if (c === 47) {
            const d = StringPrototypeCharCodeAt(src, i + 1);
            if (d === 47) {
                const e = StringPrototypeIndexOf(src, '\n', i);
                i = e < 0 ? n : e;
                continue;
            }
            if (d === 42) {
                const e = StringPrototypeIndexOf(src, '*/', i + 2);
                const end = e < 0 ? n : e + 2;
                if (StringPrototypeIncludes(RealmsSlice(src, i, end), '\n'))
                    nl = true;
                i = end;
                continue;
            }
            if (regexAllowed()) {
                let j = i + 1, cls = false;
                while (j < n) {
                    const r = StringPrototypeCharCodeAt(src, j);
                    if (r === 92) { j += 2; continue; }
                    if (r === 10) break;
                    if (cls) { if (r === 93) cls = false; }
                    else if (r === 91) cls = true;
                    else if (r === 47) break;
                    j++;
                }
                j++;
                while (j < n && isIdPart(StringPrototypeCharCodeAt(src, j))) j++;
                RealmsPush(out, { t: 're', v: '', s: i, nl });
                nl = false;
                i = j;
                continue;
            }
        }
        if (c === 39 || c === 34) {
            let j = i + 1;
            while (j < n) {
                const r = StringPrototypeCharCodeAt(src, j);
                if (r === 92) { j += 2; continue; }
                if (r === c || r === 10) break;
                j++;
            }
            RealmsPush(out, { t: 'str', v: RealmsSlice(src, i + 1, j), s: i, nl });
            nl = false;
            i = j + 1;
            continue;
        }
        if (c === 96) {
            const r = readTemplate(i + 1);
            RealmsPush(out, { t: 'tpl', v: '', s: i, nl });
            nl = false;
            if (r.open) { RealmsPush(tplDepth, braces); braces++; }
            i = r.end;
            continue;
        }
        if (c === 125 && tplDepth.length && tplDepth[tplDepth.length - 1] === braces - 1) {
            // The } that closes a template substitution: the template goes on.
            braces--;
            ArrayPrototypePopRealms(tplDepth);
            const r = readTemplate(i + 1);
            if (r.open) { RealmsPush(tplDepth, braces); braces++; }
            const p = last();
            if (p !== null && p.t !== 'tpl') RealmsPush(out, { t: 'tpl', v: '', s: i, nl: false });
            i = r.end;
            continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < n && isIdPart(StringPrototypeCharCodeAt(src, j))) j++;
            RealmsPush(out, { t: 'id', v: RealmsSlice(src, i, j), s: i, nl });
            nl = false;
            i = j;
            continue;
        }
        if ((c >= 48 && c <= 57) || (c === 46 && StringPrototypeCharCodeAt(src, i + 1) >= 48 && StringPrototypeCharCodeAt(src, i + 1) <= 57)) {
            let j = i + 1;
            while (j < n) {
                const r = StringPrototypeCharCodeAt(src, j);
                if (isIdPart(r) || r === 46) j++;
                else if ((r === 43 || r === 45) && (StringPrototypeCharCodeAt(src, j - 1) | 32) === 101 && !(StringPrototypeCharCodeAt(src, i + 1) === 120 || StringPrototypeCharCodeAt(src, i + 1) === 88)) j++;
                else break;
            }
            RealmsPush(out, { t: 'num', v: '', s: i, nl });
            nl = false;
            i = j;
            continue;
        }
        // Punctuators: the ones the scanner cares about are single characters, plus ++ -- => ?. ...
        let v = src[i];
        const two = RealmsSlice(src, i, i + 2);
        if (two === '++' || two === '--' || two === '=>' || two === '?.')
            v = two;
        else if (RealmsSlice(src, i, i + 3) === '...')
            v = '...';
        if (v === '{') braces++;
        else if (v === '}') braces--;
        RealmsPush(out, { t: 'p', v, s: i, nl });
        nl = false;
        i += v.length;
    }
    return out;
}
const ArrayPrototypePopRealms = uncurryThis(Array.prototype.pop);

// The names a binding pattern binds, from token k; returns the index after the pattern.
function bindingNames(toks, k, names) {
    const tok = toks[k];
    if (tok === undefined)
        return k;
    if (tok.t === 'id') {
        RealmsPush(names, tok.v);
        return k + 1;
    }
    if (tok.t !== 'p' || (tok.v !== '{' && tok.v !== '['))
        return k + 1;
    const object = tok.v === '{';
    const close = object ? '}' : ']';
    k++;
    while (k < toks.length && !(toks[k].t === 'p' && toks[k].v === close)) {
        const t = toks[k];
        if (t.t === 'p' && t.v === ',') { k++; continue; }
        if (t.t === 'p' && t.v === '...') { k = bindingNames(toks, k + 1, names); continue; }
        if (object) {
            // key: pattern | key = default | key | [computed]: pattern
            let keyEnd = k + 1;
            if (t.t === 'p' && t.v === '[')
                keyEnd = skipBalanced(toks, k);
            const after = toks[keyEnd];
            if (after && after.t === 'p' && after.v === ':') {
                k = bindingNames(toks, keyEnd + 1, names);
            } else {
                if (t.t === 'id')
                    RealmsPush(names, t.v);
                k = keyEnd;
            }
        } else {
            k = bindingNames(toks, k, names);
        }
        if (toks[k] && toks[k].t === 'p' && toks[k].v === '=')
            k = skipExpression(toks, k + 1, true);
    }
    return k + 1;
}
// From an opening bracket at k: the index after its partner.
function skipBalanced(toks, k) {
    let depth = 0;
    for (; k < toks.length; k++) {
        const t = toks[k];
        if (t.t !== 'p') continue;
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
            depth--;
            if (depth === 0) return k + 1;
        }
    }
    return k;
}
// An initializer: up to a comma (or, with inPattern, a closing bracket) at depth 0, a ; or a line break that ends
// the statement (ASI before a keyword that starts one).
function skipExpression(toks, k, inPattern) {
    for (; k < toks.length; k++) {
        const t = toks[k];
        if (t.t === 'p') {
            if (t.v === '(' || t.v === '[' || t.v === '{') { k = skipBalanced(toks, k) - 1; continue; }
            if (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}') return k;
        } else if (!inPattern && t.nl && t.t === 'id' && (t.v === 'var' || t.v === 'let' || t.v === 'const' || t.v === 'function' || t.v === 'class' || t.v === 'if' || t.v === 'for' || t.v === 'return')) {
            return k;
        }
    }
    return k;
}
// Declarators after var/let/const at k: the names, and the index after the list.
function declarators(toks, k, names) {
    for (;;) {
        k = bindingNames(toks, k, names);
        const t = toks[k];
        if (t && t.t === 'p' && t.v === '=')
            k = skipExpression(toks, k + 1, false);
        const u = toks[k];
        if (u && u.t === 'p' && u.v === ',') { k++; continue; }
        return k;
    }
}

// Top-level declarations of a classic script: { strict, directiveEnd (offset after the directive prologue), vars,
// functions, lexicals: [[name, kind]] }.
function scanScript(src, isModule) {
    const toks = tokenize(src);
    const vars = [], functions = [], lexicals = [];
    let strict = false, directiveEnd = 0;
    let k = 0;
    // The directive prologue: string literal statements at the start.
    while (k < toks.length && toks[k].t === 'str') {
        const next = toks[k + 1];
        if (next && !(next.t === 'p' && next.v === ';') && !next.nl && !(next.t === 'p' && next.v === '}'))
            break;
        if (toks[k].v === 'use strict')
            strict = true;
        k++;
        if (toks[k] && toks[k].t === 'p' && toks[k].v === ';') k++;
        directiveEnd = k < toks.length ? toks[k].s : src.length;
    }
    if (k === 0 || !strict)
        directiveEnd = 0;
    // The statement blocks the scan is in (it descends into those only; a function body, a class body or an object
    // literal is skipped).
    const stack = [];
    let parenHead = null;
    const parens = [];
    const atStatementStart = (j) => {
        if (j === 0) return true;
        const p = toks[j - 1];
        if (p.t === 'p') return p.v === ';' || p.v === '}' || p.v === '{';
        // A module's `export function`, `export default class`: the declaration after export is one.
        if (isModule && (p.v === 'export' || (p.v === 'default' && j > 1 && toks[j - 2].v === 'export'))) return true;
        return toks[j].nl && p.t !== 'p';
    };
    for (; k < toks.length; k++) {
        const t = toks[k];
        const depth0 = stack.length === 0 && parens.length === 0;
        if (t.t === 'p') {
            if (t.v === '(') {
                const p = toks[k - 1];
                RealmsPush(parens, p && p.t === 'id' ? p.v : '');
                continue;
            }
            if (t.v === ')') {
                parenHead = ArrayPrototypePopRealms(parens);
                // The next { after `if (...)` is a block.
                const nx = toks[k + 1];
                if (nx && nx.t === 'p' && nx.v === '{') {
                    if (RealmsSetHas(BLOCK_HEADS, parenHead) && parens.length === 0) {
                        RealmsPush(stack, true);
                        k++;
                    } else {
                        k = skipBalanced(toks, k + 1) - 1;
                    }
                }
                continue;
            }
            if (t.v === '{') {
                const p = toks[k - 1];
                const block = parens.length === 0 && (atStatementStart(k) || (p && p.t === 'id' && RealmsSetHas(BLOCK_KEYWORDS, p.v)));
                if (block)
                    RealmsPush(stack, true);
                else
                    k = skipBalanced(toks, k) - 1;
                continue;
            }
            if (t.v === '}') {
                ArrayPrototypePopRealms(stack);
                continue;
            }
            if (t.v === '[') { k = skipBalanced(toks, k) - 1; continue; }
            continue;
        }
        if (t.t !== 'id')
            continue;
        const prev = toks[k - 1];
        const member = prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.');
        if (member)
            continue;
        if (isModule && t.v === 'import' && depth0 && atStatementStart(k)) {
            // import d, { a as b, c } from '...'; import * as ns from '...'; import '...' (no names)
            let j = k + 1;
            const nx = toks[j];
            if (nx && (nx.t === 'str' || (nx.t === 'p' && (nx.v === '(' || nx.v === '.'))))
                continue; // a bare import, or import() / import.meta
            for (; j < toks.length; j++) {
                const u = toks[j];
                if (u.t === 'str' || (u.t === 'id' && u.v === 'from'))
                    break;
                if (u.t === 'id' && u.v !== 'as' && u.v !== 'type') {
                    const after = toks[j + 1];
                    if (!(after && after.t === 'id' && after.v === 'as'))
                        RealmsPush(lexicals, [u.v, 'import']);
                }
            }
            k = j;
            continue;
        }
        if (t.v === 'var' && (parens.length === 0 || (parens.length === 1 && parens[0] === 'for'))) {
            k = declarators(toks, k + 1, vars) - 1;
            continue;
        }
        if ((t.v === 'let' || t.v === 'const') && depth0) {
            const nx = toks[k + 1];
            if (nx && (nx.t === 'id' || (nx.t === 'p' && (nx.v === '{' || nx.v === '[')))) {
                const names = [];
                k = declarators(toks, k + 1, names) - 1;
                for (let i = 0; i < names.length; i++) RealmsPush(lexicals, [names[i], t.v]);
            }
            continue;
        }
        if (t.v === 'class' && atStatementStart(k)) {
            const nx = toks[k + 1];
            if (depth0 && nx && nx.t === 'id' && nx.v !== 'extends')
                RealmsPush(lexicals, [nx.v, 'class']);
            // Skip to the class body and over it.
            let j = k + 1;
            while (j < toks.length && !(toks[j].t === 'p' && toks[j].v === '{')) {
                if (toks[j].t === 'p' && (toks[j].v === '(' || toks[j].v === '[')) j = skipBalanced(toks, j);
                else j++;
            }
            k = skipBalanced(toks, j) - 1;
            continue;
        }
        if (t.v === 'function' && (atStatementStart(k) || (prev && prev.t === 'id' && prev.v === 'async' && atStatementStart(k - 1)))) {
            let j = k + 1;
            if (toks[j] && toks[j].t === 'p' && toks[j].v === '*') j++;
            if (depth0 && toks[j] && toks[j].t === 'id')
                RealmsPush(functions, toks[j].v);
            // Over the parameters and the body.
            while (j < toks.length && !(toks[j].t === 'p' && toks[j].v === '(')) j++;
            j = skipBalanced(toks, j);
            k = skipBalanced(toks, j) - 1;
            continue;
        }
    }
    // The shared names the script refers to (bound once per script, below).
    const used = [];
    const seen = new RealmsSet();
    for (let j = 0; j < toks.length; j++) {
        const t = toks[j];
        if (t.t !== 'id' || !RealmsSetHas(BINDABLE, t.v) || RealmsSetHas(seen, t.v))
            continue;
        const p = toks[j - 1];
        if (p && p.t === 'p' && (p.v === '.' || p.v === '?.'))
            continue;
        RealmsSetAdd(seen, t.v);
        RealmsPush(used, t.v);
    }
    // A module: every name it refers to (for the frame realm's prologue, moduleBindings).
    let ids = null;
    if (isModule) {
        ids = [];
        const all = new RealmsSet();
        for (let j = 0; j < toks.length; j++) {
            const t = toks[j];
            if (t.t !== 'id' || RealmsSetHas(all, t.v))
                continue;
            const p = toks[j - 1];
            if (p && p.t === 'p' && (p.v === '.' || p.v === '?.'))
                continue;
            RealmsSetAdd(all, t.v);
            RealmsPush(ids, t.v);
        }
    }
    return { strict, directiveEnd, vars, functions, lexicals, used, ids };
}

// --- Compiling a frame's classic script ----------------------------------------------------------------------------
function identifierList(names) {
    const out = [];
    for (let i = 0; i < names.length; i++) RealmsPush(out, RealmsJSONStringify(names[i]));
    return RealmsJoin(out, ',');
}
// The wrapper text for a script; `info` from scanScript. The script's body is a function body (strict when its directive
// says so), so its own top-level declarations are that function's bindings: references to them inside the script resolve
// statically, as fast as in a real script. The realm sees them through accessors registered by the prologue (live: a
// later assignment in either direction is seen by the other). The shared names the script uses (the ECMAScript globals,
// `window`, `document`...) are the parameters of the function around it, bound once when the script starts; only the
// other names go through the with-statements, at the cost of a dynamic lookup.
function frameScriptText(src, info) {
    const own = new RealmsSet();
    const entries = (names, out) => {
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (RealmsSetHas(own, name))
                continue;
            RealmsSetAdd(own, name);
            RealmsPush(out, '[' + RealmsJSONStringify(name) + ',()=>' + name + ',(__chitin_v)=>' + name + '=__chitin_v]');
        }
    };
    const vars = [], lex = [];
    entries(info.functions, vars);
    entries(info.vars, vars);
    const lexNames = [];
    for (let i = 0; i < info.lexicals.length; i++) RealmsPush(lexNames, info.lexicals[i][0]);
    entries(lexNames, lex);
    const params = [];
    for (let i = 0; i < info.used.length; i++) {
        if (!RealmsSetHas(own, info.used[i]))
            RealmsPush(params, info.used[i]);
    }
    info.params = params;
    const prologue = (vars.length || lex.length) ? '__chitin_r.d([' + RealmsJoin(vars, ',') + '],[' + RealmsJoin(lex, ',') + ']);' : '';
    const head = RealmsSlice(src, 0, info.directiveEnd);
    const rest = RealmsSlice(src, info.directiveEnd);
    return '(function(__chitin_r){with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)return function(' + RealmsJoin(params, ',')
        + '){' + head + prologue + rest + '\n}.apply(__chitin_r.t,__chitin_r.b)})';
}

// --- Frame realms --------------------------------------------------------------------------------------------------
// The ECMAScript globals every realm has (the Worker's, shared): names the guard never hides and every frame
// global carries as its own properties.
const ES_GLOBALS = ['globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent',
    'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array',
    'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Int8Array',
    'Int16Array', 'Int32Array', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect',
    'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'Intl', 'WebAssembly', 'console', 'DisposableStack', 'AsyncDisposableStack', 'SuppressedError'];
const esGlobalDescriptors = [];
function captureESGlobals() {
    for (let i = 0; i < ES_GLOBALS.length; i++) {
        const d = ObjectGetOwnPropertyDescriptor(G, ES_GLOBALS[i]);
        if (d !== undefined && ES_GLOBALS[i] !== 'globalThis')
            RealmsPush(esGlobalDescriptors, [ES_GLOBALS[i], d]);
    }
}
captureESGlobals();
const ES_GLOBAL_SET = new RealmsSet(ES_GLOBALS);
// Bound per script: the ECMAScript globals (but not eval: a direct eval must stay one) and the Window members that a
// script cannot replace ([LegacyUnforgeable] window, document; the WindowProxy's own names).
const STATIC_WINDOW_NAMES = ['window', 'self', 'globalThis', 'document', 'frames'];
const BINDABLE = new RealmsSet();
for (let i = 0; i < ES_GLOBALS.length; i++) if (ES_GLOBALS[i] !== 'eval') RealmsSetAdd(BINDABLE, ES_GLOBALS[i]);
for (let i = 0; i < STATIC_WINDOW_NAMES.length; i++) RealmsSetAdd(BINDABLE, STATIC_WINDOW_NAMES[i]);

const compiledScripts = new RealmsMap(); // source text -> { fn, info } (a frame that reloads runs the same scripts)
function compileFrameScript(source, filename) {
    const key = filename + '\n' + source;
    let entry = RealmsMapGet(compiledScripts, key);
    if (entry === undefined) {
        const info = scanScript(source);
        const fn = indirectEval(frameScriptText(source, info) + '\n//# sourceURL=' + filename);
        entry = { fn, info };
        if (compiledScripts.size > 512) compiledScripts.clear();
        RealmsMapSet(compiledScripts, key, entry);
    }
    return entry;
}

// A frame realm: `global` (the frame's global object, the target of the scope), `proxy` (its WindowProxy), the
// lexical record and the guard. Made by makeFrameRealm in the bridge, which fills the global.
function makeRealmRecord(global, proxy) {
    const lexical = ObjectCreate(null);
    const lexicalNames = new RealmsMap();
    const guard = new RealmsProxy(ObjectCreate(null), {
        __proto__: null,
        // Names the frame does not have but the principal window does: the frame must not see the parent's value. A
        // name neither has falls through to the Worker's global, where a read throws a ReferenceError as it should.
        // A sloppy assignment to a name nobody has lands on the Worker's global (the lookup fell through to it): the name is
        // remembered here, and the property is moved to the frame's global at the frame's next lookup of it (or after the
        // script, or at the next microtask checkpoint, whichever comes first).
        has(t, key) {
            if (typeof key !== 'string' || RealmsSetHas(ES_GLOBAL_SET, key) || key === '__chitin_r')
                return false;
            if (!ReflectHas(G, key)) {
                RealmsSetAdd(misses, key);
                scheduleAdopt();
                return false;
            }
            if (RealmsSetHas(misses, key) && adoptOne(key))
                return true;
            // Made on the principal window by this frame's running script (`this.name = ...`): the frame's (below).
            if (record.before !== null && !RealmsSetHas(record.before, key) && adoptOne(key))
                RealmsSetAdd(record.madeNames, key);
            return true;
        },
        get(t, key) {
            if (key === SymbolUnscopables) return undefined;
            return ReflectGet(global, key);
        },
        set(t, key, value) {
            return ReflectSet(global, key, value);
        },
        deleteProperty(t, key) {
            return ReflectDeleteProperty(global, key);
        },
    });
    const misses = new RealmsSet();
    let adoptScheduled = false;
    const adoptOne = (key) => {
        const d = ObjectGetOwnPropertyDescriptor(G, key);
        if (d === undefined || !d.configurable || !ObjectHasOwn(d, 'value') || !d.enumerable || ObjectHasOwn(global, key))
            return false;
        if (!ReflectDeleteProperty(G, key))
            return false;
        RealmsSetDelete(misses, key);
        ObjectDefineProperty(global, key, d);
        return true;
    };
    const adoptAll = () => {
        adoptScheduled = false;
        const names = ArrayFromRealms(misses);
        for (let i = 0; i < names.length; i++) {
            if (ObjectHasOwn(G, names[i]))
                adoptOne(names[i]);
        }
        if (misses.size > 4096)
            misses.clear();
    };
    const scheduleAdopt = () => {
        if (adoptScheduled || HostQueueMicrotask === null)
            return;
        adoptScheduled = true;
        HostQueueMicrotask(adoptAll);
    };
    const record = {
        __proto__: null,
        adoptAll,
        adoptName: (key) => RealmsSetHas(misses, key) && adoptOne(key),
        varNames: new RealmsSet(),
        madeNames: new RealmsSet(), // names the frame's code put on the principal window through `this` (moved here)
        before: null,               // the principal window's own names when the running script of this frame began
        global,
        proxy,
        lexical,
        lexicalNames,
        runtime: {
            __proto__: null,
            g: guard,
            w: global,
            l: lexical,
            t: proxy,
            b: null,
            d(vars, lex) {
                for (let i = 0; i < vars.length; i++) {
                    const [name, get, set] = vars[i];
                    RealmsSetAdd(record.varNames, name);
                    if (lentRecord === record)
                        lendOne(record, name);
                    const d = ObjectGetOwnPropertyDescriptor(global, name);
                    if (d === undefined || d.configurable)
                        ObjectDefineProperty(global, name, { get, set, enumerable: true, configurable: false });
                    else if (ObjectHasOwn(d, 'value') && d.writable)
                        global[name] = get();
                }
                for (let i = 0; i < lex.length; i++) {
                    const [name, get, set] = lex[i];
                    RealmsMapSet(lexicalNames, name, true);
                    ObjectDefineProperty(lexical, name, { get, set, enumerable: false, configurable: true });
                }
            },
        },
    };
    return record;
}

// A sloppy function's default `this` (and the `this` of a function called without a receiver) is its realm's global, and
// every function of a frame's scripts is the Worker realm's: `(function () { this.locale_data.duckduckgo = ... })()` in a
// frame's script (DuckDuckGo's util.js) reaches the principal window, the Worker's global. Its prototype chain cannot
// be changed (a [Global] interface's chain is immutable), so while a frame's classic script runs the frame's own
// globals (its declared vars and functions, the names it made) are lent to the principal window as accessors to the
// frame's global, for the names the principal window does not have, and taken back after the script; a property the
// script created on the principal window meanwhile (`this.name = ...`) is moved to the frame's global. Names the
// principal window has (`this.document`) stay its own (docs/surface.md); callbacks the frame's code left behind do
// not borrow anything.
const lentNames = [];
let lentRecord = null;
function lendOne(record, name) {
    if (typeof name !== 'string' || ObjectHasOwn(G, name) || RealmsSetHas(ES_GLOBAL_SET, name))
        return;
    const global = record.global;
    const get = function () { return ReflectGet(global, name); };
    const set = function (value) { ReflectSet(global, name, value); };
    ObjectDefineProperty(G, name, { get, set, enumerable: false, configurable: true });
    RealmsPush(lentNames, [name, get]);
}
function lendFrameNames(record) {
    lentRecord = record;
    for (const name of record.varNames) lendOne(record, name);
    for (const name of record.madeNames) lendOne(record, name);
}
function takeBackFrameNames() {
    for (let i = 0; i < lentNames.length; i++) {
        const [name, get] = lentNames[i];
        const d = ObjectGetOwnPropertyDescriptor(G, name);
        if (d !== undefined && d.get === get)
            ReflectDeleteProperty(G, name);
    }
    lentNames.length = 0;
    lentRecord = null;
}
// The principal window's own names before a frame's script: what is new after it is the frame's.
function principalKeys() {
    return new RealmsSet(ReflectOwnKeys(G));
}
function moveMadeNames(record, before) {
    const after = ReflectOwnKeys(G);
    if (after.length === before.size)
        return;
    for (let i = 0; i < after.length; i++) {
        const key = after[i];
        if (typeof key !== 'string' || RealmsSetHas(before, key))
            continue;
        const d = ObjectGetOwnPropertyDescriptor(G, key);
        if (d === undefined || !d.configurable || ObjectHasOwn(record.global, key))
            continue;
        if (!ReflectDeleteProperty(G, key))
            continue;
        ObjectDefineProperty(record.global, key, d);
        RealmsSetAdd(record.madeNames, key);
    }
}

// Runs a classic script of the frame realm `record`.
function runFrameScript(record, source, filename) {
    const { fn, info } = compileFrameScript(source, filename);
    // The realm a script of this URL runs in, for the incumbent of calls from host jobs (40-bridge.js callerRealmCell).
    if (typeof noteScriptRealm === 'function')
        noteScriptRealm(filename, record.global);
    // A redeclared global lexical is the page's SyntaxError, as in a real realm.
    for (let i = 0; i < info.lexicals.length; i++) {
        const name = info.lexicals[i][0];
        if (RealmsMapHas(record.lexicalNames, name))
            throw new RealmsSyntaxError("Identifier '" + name + "' has already been declared");
    }
    const global = record.global;
    const params = info.params;
    const values = [];
    for (let i = 0; i < params.length; i++)
        values[i] = ReflectGet(global, params[i]);
    record.runtime.b = values;
    // A script inside another's (document.write, a frame's frame): the outer one's loan is taken back and made again after.
    const outer = lentRecord;
    if (outer !== null)
        takeBackFrameNames();
    const before = principalKeys();
    const outerBefore = record.before;
    record.before = before;
    lendFrameNames(record);
    try {
        return ReflectApply(fn, undefined, [record.runtime]);
    } finally {
        record.runtime.b = null;
        takeBackFrameNames();
        moveMadeNames(record, before);
        record.before = outerBefore;
        record.adoptAll(); // a sloppy assignment to an undeclared name (the guard above)
        if (outer !== null)
            lendFrameNames(outer);
        syncFrameIndices();
    }
}

// Event handler content attributes of a frame's document: the element, form and document scopes inside the frame's.
function frameHandlerFactory(record, scopeCount, source) {
    let code = '';
    for (let i = scopeCount - 1; i >= 0; i--)
        code += 'with (__chitin_scopes[' + i + ']) ';
    return HostFunction('__chitin_r', '__chitin_scopes', 'with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)' + code + 'return (' + source + '\n);');
}

// --- The realms of the segment's frames ----------------------------------------------------------------------------
let frameRealmsOn = false;
const realmByWindowCell = new RealmsMap();  // a frame Window's global object cell -> its realm record

function rawCell(fn, cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    const ok = fn(o, r);
    views();
    const out = ok && (u32[(r >>> 2) + 1] >>> 16) === TAG_OBJECT ? u32[r >>> 2] : 0;
    scratchTop = mark;
    return out;
}
function windowOfProxy(wpCell) {
    return rawCell(X.ganglion_v_window_proxy_window, wpCell);
}
function currentGlobalCell() {
    const mark = scratchTop;
    const g = slots(1);
    X.ganglion_js_current_global(g);
    views();
    const cell = u32[g >>> 2];
    scratchTop = mark;
    return cell;
}

// The page object for a frame's WindowProxy, made with each realm of the navigable (record.proxy). It forwards every
// operation to the global of the Window the navigable has *now*, so a reference kept across the frame's navigation
// still reaches the frame's current document; the object the page is handed is the current realm's (identity across a
// navigation is the residue, docs/surface.md). Each has a target of its own for the Proxy invariants: a page that defines
// a non-configurable property on its window (Scramjet's `$scramjet$rewrite`) gets it on the frame's global and on the
// target, so the definition is allowed and reads back as defined; other own properties read as configurable.
function makeWindowProxyObject(home, wpCell) {
    const target = ObjectCreate(null);
    const current = () => {
        const windowCell = windowOfProxy(wpCell);
        const record = windowCell === 0 ? null : realmForWindow(windowCell, wpCell);
        if (record === null)
            throw typeError('The frame has no window');
        return record;
    };
    // A non-configurable property the page fixed through this object: the target's answer stands (the invariants), the
    // current global's when it is this object's own realm.
    const fixed = (key) => {
        const d = ObjectGetOwnPropertyDescriptor(target, key);
        return d !== undefined && !d.configurable ? d : undefined;
    };
    const proxy = new RealmsProxy(target, {
        __proto__: null,
        get(t, key) {
            if (typeof key === 'string' && isArrayIndex(key))
                return indexedFrame(wpCell, key);
            const r = current();
            const f = fixed(key);
            if (f !== undefined && r !== home && ObjectHasOwn(f, 'value') && !f.writable)
                return f.value;
            r.adoptName(key);
            return ReflectGet(r.global, key);
        },
        set(t, key, value) { return ReflectSet(current().global, key, value); },
        has(t, key) {
            if (typeof key === 'string' && isArrayIndex(key))
                return indexedFrame(wpCell, key) !== undefined;
            if (fixed(key) !== undefined)
                return true;
            const r = current();
            r.adoptName(key);
            return ReflectHas(r.global, key);
        },
        deleteProperty(t, key) {
            if (fixed(key) !== undefined)
                return false;
            return ReflectDeleteProperty(current().global, key);
        },
        ownKeys(t) {
            const keys = ReflectOwnKeys(current().global);
            const own = ReflectOwnKeys(t);
            const seen = new RealmsSet(keys);
            for (let i = 0; i < own.length; i++) {
                if (!RealmsSetHas(seen, own[i]))
                    RealmsPush(keys, own[i]);
            }
            return keys;
        },
        getOwnPropertyDescriptor(t, key) {
            if (typeof key === 'string' && isArrayIndex(key)) {
                const child = indexedFrame(wpCell, key);
                return child === undefined ? undefined : { value: child, writable: false, enumerable: true, configurable: true };
            }
            const f = fixed(key);
            const record = current();
            if (f !== undefined) {
                if (record !== home || !ObjectHasOwn(f, 'value') || !f.writable)
                    return f;
                const now = ObjectGetOwnPropertyDescriptor(record.global, key);
                return { value: now !== undefined && ObjectHasOwn(now, 'value') ? now.value : f.value, writable: true, enumerable: f.enumerable, configurable: false };
            }
            record.adoptName(key);
            const d = ObjectGetOwnPropertyDescriptor(record.global, key);
            if (d === undefined)
                return undefined;
            if (RealmsSetHas(record.varNames, key) && d.get !== undefined)
                return { value: ReflectApply(d.get, record.global, []), writable: true, enumerable: true, configurable: true };
            d.configurable = true;
            return d;
        },
        defineProperty(t, key, d) {
            const record = current();
            const desc = { __proto__: null };
            if (ObjectHasOwn(d, 'value')) desc.value = d.value;
            if (ObjectHasOwn(d, 'writable')) desc.writable = d.writable;
            if (ObjectHasOwn(d, 'get')) desc.get = d.get;
            if (ObjectHasOwn(d, 'set')) desc.set = d.set;
            if (ObjectHasOwn(d, 'enumerable')) desc.enumerable = d.enumerable;
            if (d.configurable === false) {
                // As asked, on the global and on the target (whose answer must agree from now on).
                desc.configurable = false;
                if (!ReflectDefineProperty(record.global, key, desc))
                    return false;
                const full = ObjectGetOwnPropertyDescriptor(record.global, key);
                return ReflectDefineProperty(t, key, full);
            }
            if (fixed(key) !== undefined)
                return ReflectDefineProperty(t, key, d) && ReflectDefineProperty(record.global, key, d);
            desc.configurable = true;
            return ReflectDefineProperty(record.global, key, desc);
        },
        getPrototypeOf() { return ObjectGetPrototypeOf(current().global); },
        setPrototypeOf(t, proto) { return proto === ObjectGetPrototypeOf(current().global); },
        isExtensible() { return true; },
        preventExtensions() { return false; },
    });
    WeakMapPrototypeSet(cellOf, proxy, wpCell);
    return proxy;
}
// The page object for a frame's WindowProxy now: its current realm's.
function frameWindowProxy(wpCell) {
    const windowCell = windowOfProxy(wpCell);
    if (windowCell === 0)
        throw typeError('The frame has no window');
    return realmForWindow(windowCell, wpCell).proxy;
}

// `Function` of a frame realm: a function built from source text resolves its free names in the frame (a proxy's client code
// compiles the pages it rewrites with it, and `location` must be the frame's). The function is the Worker realm's
// (`instanceof Function` and Function.prototype are the shared ones); the text is checked by the host's Function first,
// so the errors are V8's.
function frameFunctionConstructor(record) {
    const ctor = { Function: function (...args) {
        const body = args.length ? HostString(args[args.length - 1]) : '';
        const params = [];
        for (let i = 0; i < args.length - 1; i++) RealmsPush(params, HostString(args[i]));
        const list = RealmsJoin(params, ',');
        ReflectApply(HostFunction, undefined, [...params, body]); // the early errors
        return HostFunction('__chitin_r', 'with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)return function anonymous(' + list + '\n) {\n' + body + '\n}')(record.runtime);
    } }.Function;
    ObjectDefineProperty(ctor, 'prototype', { value: HostFunction.prototype, writable: false, enumerable: false, configurable: false });
    ObjectDefineProperty(ctor, 'length', { value: 1, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, ctor);
    return ctor;
}

// frames[i] of a window (the WindowProxy's indexed properties: its document's child navigables, in order).
function indexedFrame(wpCell, key) {
    const entered = idleEntry();
    try {
        return vGet(wpCell, key);
    } finally {
        idleExit(entered);
    }
}
// The principal window's frames[i] (the Worker's global cannot have indexed properties of its own making): own data
// properties 0..length-1 kept in step with the engine's child navigables after each script, at each pump and when a frame
// realm appears, as Chrome shows them (enumerable, configurable, read-only).
let principalFrameCount = 0;
function syncFrameIndices() {
    if (!frameRealmsOn || globalCell === 0)
        return;
    let n = 0;
    const entered = idleEntry();
    try {
        const length = vGet(globalCell, 'length');
        n = typeof length === 'number' ? length : 0;
        for (let i = 0; i < n; i++) {
            const child = vGet(principalWindowProxyCell(), HostString(i));
            const d = ObjectGetOwnPropertyDescriptor(G, HostString(i));
            if (d === undefined || d.value !== child)
                ObjectDefineProperty(G, HostString(i), { value: child, writable: false, enumerable: true, configurable: true });
        }
    } catch {
        // a document going away: try again next time
    } finally {
        idleExit(entered);
    }
    for (let i = n; i < principalFrameCount; i++)
        ReflectDeleteProperty(G, HostString(i));
    principalFrameCount = n;
    syncFrameNames();
}
// The principal window's named frames (window[name], frames[name]: the document-tree child navigable target names, as
// reCAPTCHA's challenge frame finds its anchor with parent.frames[name]). Chrome answers them from the named properties
// object behind Window.prototype; here they are data properties on that object (WindowProperties, docs/surface.md),
// so the global's own names and Window.prototype's still win, kept in step with the iframes' name attributes.
let principalFrameNames = [];
function syncFrameNames() {
    if (!framesInstalled || F.nameGet === undefined)
        return;
    let windowProperties = null;
    try {
        windowProperties = ObjectGetPrototypeOf(ObjectGetPrototypeOf(G));
    } catch {
        return;
    }
    // Only the surface's named properties object (45-surface.js), never a prototype other objects share.
    if (windowProperties === null || ObjectGetOwnPropertyDescriptor(windowProperties, SymbolToStringTag) === undefined || windowProperties[SymbolToStringTag] !== 'WindowProperties')
        return;
    const names = [];
    const values = [];
    try {
        const doc = ReflectApply(F.documentGet, G, []);
        const list = ReflectApply(F.getElementsByTagName, doc, ['iframe']);
        const n = ReflectApply(F.collectionLength, list, []);
        for (let i = 0; i < n; i++) {
            const el = ReflectApply(F.collectionItem, list, [i]);
            const name = ReflectApply(F.nameGet, el, []);
            if (typeof name !== 'string' || name === '' || RealmsArrayIncludes(names, name))
                continue;
            const w = remoteUrl(el) !== null ? frameProxy(el) : ReflectApply(F.contentWindowGet, el, []);
            if (w === null || w === undefined)
                continue;
            RealmsPush(names, name);
            RealmsPush(values, w);
        }
    } catch {
        return; // a document going away: next time
    }
    for (let i = 0; i < principalFrameNames.length; i++)
        if (!RealmsArrayIncludes(names, principalFrameNames[i]))
            ReflectDeleteProperty(windowProperties, principalFrameNames[i]);
    for (let i = 0; i < names.length; i++) {
        const d = ObjectGetOwnPropertyDescriptor(windowProperties, names[i]);
        if (d === undefined || d.value !== values[i])
            ObjectDefineProperty(windowProperties, names[i], { value: values[i], writable: true, enumerable: false, configurable: true });
    }
    principalFrameNames = names;
}

// The realm of a frame's Window (its global object cell), made on first use: a global filled from the Window's members
// (bound to it), the ECMAScript globals, and the frame's WindowProxy for `window`, `self`, `globalThis` and `this`.
function realmForWindow(windowCell, wpCell) {
    let record = RealmsMapGet(realmByWindowCell, windowCell);
    if (record !== undefined)
        return record;
    if (wpCell === 0)
        wpCell = rawCell((o, r) => X.ganglion_v_get(o, keyBits('window'), r) === 0, windowCell);
    const protoCell = vPrototypeCell(windowCell);
    const cls = protoCell === 0 ? null : classForPrototype(protoCell);
    const global = ObjectCreate(cls !== null ? cls.prototype : HostObject.prototype);
    WeakMapPrototypeSet(cellOf, global, windowCell);
    record = makeRealmRecord(global, null);
    const proxy = makeWindowProxyObject(record, wpCell);
    record.proxy = proxy;
    record.runtime.t = proxy;
    record.windowCell = windowCell;
    record.wpCell = wpCell;
    record.id = nextRealmId++;
    RealmsMapSet(realmByWindowCell, windowCell, record);
    RealmsMapSet(realmById, record.id, record);
    for (let i = 0; i < esGlobalDescriptors.length; i++)
        ObjectDefineProperty(global, esGlobalDescriptors[i][0], esGlobalDescriptors[i][1]);
    ObjectDefineProperty(global, 'globalThis', { value: proxy, writable: true, enumerable: false, configurable: true });
    ObjectDefineProperty(global, 'Function', { value: frameFunctionConstructor(record), writable: true, enumerable: false, configurable: true });
    // The Window's members, from its prototype chain and its own properties, as own properties of the frame's global
    // (as the principal window's are of the Worker's global), bound to the frame's Window.
    const chain = [];
    for (let p = protoCell; p !== 0 && p !== objectPrototypeCell; p = vPrototypeCell(p))
        RealmsPush(chain, p);
    for (let i = chain.length - 1; i >= 0; i--) {
        const keys = vOwnKeys(chain[i]);
        for (let k = 0; k < keys.length; k++) {
            const key = keyToJS(keys[k]);
            if (key === 'constructor' || typeof key === 'symbol' || HOST_ONLY_GLOBALS[key] === true)
                continue;
            defineMember(global, chain[i], keys[k], key, global);
        }
        classForPrototype(chain[i]);
    }
    const own = vOwnKeys(windowCell);
    for (let k = 0; k < own.length; k++) {
        const key = keyToJS(own[k]);
        // WebAssembly stays the host's, as on the principal window (40-bridge.js HOST_ONLY_GLOBALS): the engine's own
        // namespace is LibWasm, an interpreter with its own memory limits (Scramjet's rewriter failed in it with
        // "Failed to allocate a memory instance"), and the frame's ECMAScript globals are the host's already.
        if (typeof key === 'symbol' || key === 'Worker' || key === 'SharedWorker' || HOST_ONLY_GLOBALS[key] === true)
            continue;
        defineMember(global, windowCell, own[k], key, global);
    }
    installFrameQueueMicrotask(global);
    // SharedArrayBuffer only in a cross-origin isolated frame (the engine's crossOriginIsolated for its document: the top-level
    // document isolated and the frame allowed "cross-origin-isolated"), as on the principal window (setPageIsolation).
    let frameIsolated = false;
    try { frameIsolated = global.crossOriginIsolated === true; } catch { frameIsolated = false; }
    if (!frameIsolated)
        ReflectDeleteProperty(global, 'SharedArrayBuffer');
    record.isolated = frameIsolated;
    // The host's own interfaces for the frame (a dedicated Worker whose URLs are the frame's: harness/segment/pagesw-host.js).
    if (typeof callbacks.frameRealmCreated === 'function') {
        try { callbacks.frameRealmCreated(global); } catch { /* the frame goes on without them */ }
    }
    syncFrameIndices();
    return record;
}
function installFrameQueueMicrotask(global) {
    if (HostQueueMicrotask === null)
        return;
    const queue = {
        queueMicrotask(callback) {
            if (typeof callback !== 'function')
                throw typeError("Failed to execute 'queueMicrotask' on 'Window': parameter 1 is not of type 'Function'.");
            HostQueueMicrotask(() => {
                try {
                    callback();
                } catch (e) {
                    try { global.reportError(e); } catch { /* nothing more to do with it */ }
                }
            });
        },
    }.queueMicrotask;
    WeakSetPrototypeAdd(nativeFunctions, queue);
    ObjectDefineProperty(global, 'queueMicrotask', { value: queue, writable: true, enumerable: true, configurable: true });
}

// The page object for a WindowProxy that is not the principal window's: a frame realm's when the frame is same-origin
// with the page, otherwise the engine-checked stand-in (frameWindow in 40-bridge.js).
function windowProxyToJS(wpCell) {
    if (!frameRealmsOn)
        return null;
    const windowCell = windowOfProxy(wpCell);
    if (windowCell === 0 || windowCell === globalCell)
        return null;
    // Same origin as the script asking (HTML's WindowProxy checks are relative to the accessing realm): a frame's own code
    // reading its `window` gets its realm's proxy even when the frame is cross-origin to the principal page (hCaptcha's
    // frames: newassets.hcaptcha.com in accounts.hcaptcha.com; `delete window.msgpack` hit the stand-in and threw).
    const asking = currentGlobalCell();
    let origin, own;
    try {
        origin = vGet(windowCell, 'origin');
        own = vGet(asking !== 0 ? asking : globalCell, 'origin');
    } catch {
        return null;
    }
    if (origin !== own)
        return null;
    return frameWindowProxy(wpCell);
}

// The engine asks the host to run a classic script: a frame realm's when its execution context is a frame's.
function frameRealmOfCurrentScript() {
    if (!frameRealmsOn)
        return null;
    const cell = currentGlobalCell();
    if (cell === 0 || cell === globalCell)
        return null;
    return realmForWindow(cell, 0);
}
// A handler's last scope is a frame's global object only when the engine put it there (Bridge.cpp): a Window.
function frameRealmOfGlobalCell(cell) {
    if (!frameRealmsOn || cell === 0 || cell === globalCell)
        return null;
    if (!RealmsMapHas(realmByWindowCell, cell) && vClassName(cell) !== globalClassName())
        return null;
    return realmForWindow(cell, 0);
}
let principalClassName = null;
function globalClassName() {
    if (principalClassName === null)
        principalClassName = vClassName(globalCell);
    return principalClassName;
}

// The principal document was replaced: the frames of the old one are gone.
function resetFrameRealms() {
    for (let i = 0; i < principalFrameCount; i++)
        ReflectDeleteProperty(G, HostString(i));
    principalFrameCount = 0;
    realmByWindowCell.clear();
    realmById.clear();
}

// The ECMAScript built-ins are the Worker's and shared by every frame realm (docs/surface.md): a frame's page that fixes
// a non-configurable property on one (Scramjet's client defines `$scramjet__location` on `Object.prototype` with
// configurable: false) fixes it for the next document of that frame as well, whose own client then fails with "Cannot
// redefine property" (in Chrome the next document has an Object.prototype of its own). While a frame's code runs, a
// property it defines on a shared built-in (a constructor, its prototype, JSON, Math, Reflect...) is kept configurable,
// so a later document of a frame can define it again; what the principal document defines is left as it is.
const SharedBuiltins = new RealmsSet();
const frameFixed = new (globalThis.WeakMap)(); // shared built-in -> the keys frames defined on it
let builtinGuardInstalled = false;
function frameRealmNow() {
    if (realmByWindowCell.size === 0)
        return false;
    const cell = currentGlobalCell();
    return cell !== 0 && cell !== globalCell && RealmsMapHas(realmByWindowCell, cell);
}
function looseForFrame(target, key, desc) {
    if (!RealmsSetHas(SharedBuiltins, target) || desc === null || typeof desc !== 'object' || desc.configurable === true || !frameRealmNow())
        return desc;
    let keys = WeakMapPrototypeGet(frameFixed, target);
    const k = typeof key === 'symbol' ? key : HostString(key);
    if (ObjectHasOwn(target, k) && (keys === undefined || !RealmsSetHas(keys, k)))
        return desc; // the principal's (or the built-in's own): as it is
    if (keys === undefined) {
        keys = new RealmsSet();
        WeakMapPrototypeSet(frameFixed, target, keys);
    }
    RealmsSetAdd(keys, k);
    const loose = ObjectCreate(null);
    for (const n of ['value', 'writable', 'get', 'set', 'enumerable'])
        if (ReflectHas(desc, n))
            loose[n] = desc[n];
    loose.configurable = true;
    return loose;
}
function installBuiltinGuard() {
    if (builtinGuardInstalled)
        return;
    builtinGuardInstalled = true;
    for (let i = 0; i < esGlobalDescriptors.length; i++) {
        const v = esGlobalDescriptors[i][1].value;
        if ((typeof v === 'object' && v !== null) || typeof v === 'function') {
            RealmsSetAdd(SharedBuiltins, v);
            if (typeof v === 'function' && typeof v.prototype === 'object' && v.prototype !== null)
                RealmsSetAdd(SharedBuiltins, v.prototype);
        }
    }
    const define = ObjectDefineProperty;
    const reflectDefine = HostReflect.defineProperty;
    const defineAll = HostObject.defineProperties;
    const wrapped = {
        defineProperty(o, p, attributes) { return define(o, p, looseForFrame(o, p, attributes)); },
        defineProperties(o, properties) {
            if (!RealmsSetHas(SharedBuiltins, o) || properties === null || typeof properties !== 'object')
                return defineAll(o, properties);
            const out = ObjectCreate(null);
            const keys = ReflectOwnKeys(properties);
            for (let i = 0; i < keys.length; i++)
                out[keys[i]] = looseForFrame(o, keys[i], properties[keys[i]]);
            return defineAll(o, out);
        },
    };
    const reflectWrapped = { defineProperty(o, p, attributes) { return reflectDefine(o, p, looseForFrame(o, p, attributes)); } };
    for (const [holder, name, f] of [[HostObject, 'defineProperty', wrapped.defineProperty], [HostObject, 'defineProperties', wrapped.defineProperties], [HostReflect, 'defineProperty', reflectWrapped.defineProperty]]) {
        WeakSetPrototypeAdd(nativeFunctions, f);
        define(holder, name, { value: f, writable: true, enumerable: false, configurable: true });
    }
}

function enableFrameRealms(on) {
    if (!on || typeof X.ganglion_js_frame_realms !== 'function' || typeof X.ganglion_js_current_global !== 'function' || typeof X.ganglion_v_window_proxy_window !== 'function')
        return false;
    X.ganglion_js_frame_realms(1);
    frameRealmsOn = true;
    installBuiltinGuard();
    return true;
}

// --- A frame's module scripts --------------------------------------------------------------------------------------
// The host's V8 loads a module and its imports itself, in the Worker's realm, where a module's free names are the
// Worker's global (the principal window). A frame's module graph is loaded under the realm's own name in the segment's
// mirror (/__chitin/r/<id>/o/https/<host>/<path>, harness/segment/sw.js), so it is a module graph of its own (a chunk
// the parent page also imports is evaluated again, for the frame), and the service worker puts one fixed line in
// front of each of its modules: an import of the realm's accessor module and a `const` destructuring of the frame's
// WindowProxy for the names the module uses that are the frame's or the principal window's and that the module does
// not declare itself (docs/architecture.md "Frame realms"). Nothing else in the module changes. The names are read
// once, when the module is evaluated (a later replacement of a frame global is not seen by a module that read it).
const realmById = new RealmsMap();
let nextRealmId = 1;
let inlineFrameModules = 0;
const MODULE_NEVER_BOUND = new RealmsSet(['arguments', 'await', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public',
    'enum', 'eval', 'undefined', 'NaN', 'Infinity', '__chitin_f']);
function moduleBindings(record, text) {
    const info = scanScript(text, true);
    const declared = new RealmsSet();
    for (let i = 0; i < info.vars.length; i++) RealmsSetAdd(declared, info.vars[i]);
    for (let i = 0; i < info.functions.length; i++) RealmsSetAdd(declared, info.functions[i]);
    for (let i = 0; i < info.lexicals.length; i++) RealmsSetAdd(declared, info.lexicals[i][0]);
    const names = [];
    const ids = info.ids;
    for (let i = 0; i < ids.length; i++) {
        const name = ids[i];
        if (RealmsSetHas(declared, name) || RealmsSetHas(MODULE_NEVER_BOUND, name))
            continue;
        if (RealmsSetHas(ES_GLOBAL_SET, name) && name !== 'globalThis' && ReflectGet(record.global, name) === ReflectGet(G, name))
            continue; // the shared built-in: the module reaches it as it is
        if (ReflectHas(record.global, name) || ReflectHas(G, name))
            RealmsPush(names, name);
    }
    return names;
}
function frameModuleBindings(realmId, text) {
    const record = RealmsMapGet(realmById, realmId);
    if (record === undefined)
        return [];
    return moduleBindings(record, text);
}

// A module script of a frame: the host imports it under the realm's mirror name (callbacks.runFrameModule).
function runFrameModule(record, source, filename, lineOffset) {
    if (typeof callbacks.runFrameModule !== 'function')
        return PromiseReject(new HostTypeError('segment: this host cannot run a frame\'s module scripts: ' + filename));
    const text = '\n'.repeat(lineOffset > 1 ? lineOffset - 1 : 0) + source;
    // An inline module has the document's URL, which cannot be imported twice: a query names it (as for the page's).
    let href = '';
    try { href = HostString(ReflectGet(ReflectGet(record.global, 'location'), 'href')).replace(/#.*$/, ''); } catch { /* none */ }
    if (href !== '' && HostString(filename).replace(/#.*$/, '') === href)
        filename = href + (StringPrototypeIncludes(href, '?') ? '&' : '?') + '__chitin_module=' + (++inlineFrameModules);
    return callbacks.runFrameModule(text, filename, record.id, record.proxy, moduleBindings(record, text));
}

// ===== glue/engine/57-importmap.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Import maps (docs/architecture.md "Import maps"). The map is the engine's: LibWeb registers every
// <script type="importmap"> of a document and merges them (HTML "merge existing and new import maps").
// The host's V8 resolves page modules' specifiers without it (a Worker has no import map), so the segment's
// service worker replaces each specifier the map remaps with the map's URL (harness/segment/specifiers.js).
// Here: "resolve a module specifier" against the engine's map (HTML 8.1.5.3), in the spec's key order (code units
// descending: the longest prefix first), the resolved module set kept, and Chrome's wording for the failures.

// The host's URL parser (WHATWG URL, as V8's module resolution uses it), given by the host at boot (callbacks.HostURL): the
// global URL may be the engine's by the time a module loads.
let IMURL = null, IMhref = null, IMprotocol = null;
function imURLClass() {
    if (IMURL === null) {
        const C = callbacks.HostURL || globalThis.URL;
        IMhref = uncurryThis(ObjectGetOwnPropertyDescriptor(C.prototype, 'href').get);
        IMprotocol = uncurryThis(ObjectGetOwnPropertyDescriptor(C.prototype, 'protocol').get);
        IMURL = C;
    }
    return IMURL;
}
const IMJSONParse = globalThis.JSON.parse;
const IMKeys = globalThis.Object.keys;
const IMSort = uncurryThis(globalThis.Array.prototype.sort);
const IMPush = uncurryThis(globalThis.Array.prototype.push);
const IMStartsWith = uncurryThis(globalThis.String.prototype.startsWith);
const IMEndsWith = uncurryThis(globalThis.String.prototype.endsWith);
const IMSlice = uncurryThis(globalThis.String.prototype.slice);
const IMReplace = uncurryThis(globalThis.String.prototype.replace);
const imUtf8 = new TextDecoder();
const IM_SPECIAL = { __proto__: null, 'ftp:': true, 'file:': true, 'http:': true, 'https:': true, 'ws:': true, 'wss:': true };

function imParseURL(input, base) {
    const C = imURLClass();
    try {
        return base === undefined ? new C(input) : new C(input, base);
    } catch {
        return null;
    }
}

// The global object cell of a realm id: 0 is the principal window, a frame realm's is its Window's (55-realms.js).
function imGlobalCell(realmId) {
    if (!realmId)
        return globalCell;
    const record = RealmsMapGet(realmById, realmId);
    return record === undefined ? 0 : record.windowCell;
}

const imDescending = (a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0);
function imEntries(object) {
    const keys = IMKeys(object);
    const out = [];
    for (let i = 0; i < keys.length; i++)
        IMPush(out, [keys[i], object[keys[i]]]);
    return IMSort(out, imDescending);
}

// The engine's import map of a realm: { imports: [[key, url|null]], scopes: [[prefix, entries]], integrity } (sorted as
// the spec iterates them), or null when there is none to read.
function imMap(realmId) {
    const cell = imGlobalCell(realmId);
    if (!cell || typeof X.ganglion_import_map_json !== 'function')
        return null;
    const mark = scratchTop;
    try {
        const o = slots(1), len = slots(1);
        writeObject(o, cell);
        const ptr = X.ganglion_import_map_json(o, len);
        views();
        if (!ptr)
            return null;
        const n = u32[len >>> 2];
        const copy = new (globalThis.Uint8Array)(n);
        for (let i = 0; i < n; i++)
            copy[i] = u8[ptr + i];
        const raw = IMJSONParse(TextDecoderPrototypeDecode(imUtf8, copy));
        const scopes = imEntries(raw.scopes);
        for (let i = 0; i < scopes.length; i++)
            scopes[i][1] = imEntries(scopes[i][1]);
        return { __proto__: null, imports: imEntries(raw.imports), scopes, integrity: raw.integrity };
    } finally {
        scratchTop = mark;
    }
}

function imRecordResolved(realmId, base, normalized, asURL) {
    const cell = imGlobalCell(realmId);
    if (!cell || typeof X.ganglion_import_map_resolved !== 'function')
        return;
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const b = stringToEngine(base), s = stringToEngine(normalized);
    try {
        X.ganglion_import_map_resolved(o, b, base.length, s, normalized.length, asURL === null || IM_SPECIAL[IMprotocol(asURL)] === true ? 1 : 0);
    } finally {
        X.ganglion_free(b);
        X.ganglion_free(s);
        scratchTop = mark;
    }
}

// "resolve a URL-like module specifier"
function imURLLike(specifier, base) {
    if (IMStartsWith(specifier, '/') || IMStartsWith(specifier, './') || IMStartsWith(specifier, '../'))
        return imParseURL(specifier, base);
    return imParseURL(specifier);
}

// "resolve an imports match": { url } | { blocked, key } | null
function imMatch(normalized, asURL, entries) {
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i][0], result = entries[i][1];
        if (key === normalized) {
            if (result === null)
                return { __proto__: null, blocked: 'null', key };
            return { __proto__: null, url: result };
        }
        if (IMEndsWith(key, '/') && IMStartsWith(normalized, key) && (asURL === null || IM_SPECIAL[IMprotocol(asURL)] === true)) {
            if (result === null)
                return { __proto__: null, blocked: 'null', key };
            const url = imParseURL(IMSlice(normalized, key.length), result);
            if (url === null)
                return { __proto__: null, blocked: 'parse', key };
            const href = IMhref(url);
            if (!IMStartsWith(href, result))
                return { __proto__: null, blocked: 'backtrack', key };
            return { __proto__: null, url: href };
        }
    }
    return null;
}

const IM_BLOCKED = { __proto__: null, null: 'is blocked by a null value', parse: 'is blocked due to relative URL parse failure', backtrack: 'is blocked due to backtracking' };

// One specifier against a map: { url, mapped } (mapped: the map changed what the host would resolve), or { error,
// staticMessage, dynamicMessage } in Chrome's words (a static import's error names the reason; import() and
// import.meta.resolve say only the specifier).
function imResolveOne(realmId, map, base, specifier) {
    const asURL = imURLLike(specifier, base);
    const normalized = asURL !== null ? IMhref(asURL) : specifier;
    let result = null;
    for (let i = 0; i < map.scopes.length && result === null; i++) {
        const prefix = map.scopes[i][0];
        if (prefix === base || (IMEndsWith(prefix, '/') && IMStartsWith(base, prefix)))
            result = imMatch(normalized, asURL, map.scopes[i][1]);
    }
    if (result === null)
        result = imMatch(normalized, asURL, map.imports);
    if (result !== null && result.blocked !== undefined) {
        return {
            __proto__: null,
            error: result.blocked,
            staticMessage: `Failed to resolve module specifier "${specifier}". Import Map: "${normalized}" matches with "${result.key}" but ${IM_BLOCKED[result.blocked]}`,
            dynamicMessage: `Failed to resolve module specifier '${specifier}'`,
        };
    }
    if (result === null && asURL === null) {
        return {
            __proto__: null,
            error: 'bare',
            staticMessage: `Failed to resolve module specifier "${specifier}". Relative references must start with either "/", "./", or "../".`,
            dynamicMessage: `Failed to resolve module specifier '${specifier}'`,
        };
    }
    imRecordResolved(realmId, base, normalized, asURL);
    if (result === null)
        return { __proto__: null, url: normalized, mapped: false };
    return { __proto__: null, url: result.url, mapped: result.url !== normalized || asURL === null };
}

// An inline module is imported under the document's URL with a query that names it (40-bridge.js); its base URL is the
// document's.
const imBase = (base) => IMReplace(HostString(base), /[?&]__chitin_module=\d+$/, '');

// Whether a realm's document has an import map with anything in imports or scopes (no map: the service worker leaves
// modules alone, and V8's own errors are already Chrome's).
api.importMapActive = (realmId) => {
    const map = imMap(realmId);
    return map !== null && (map.imports.length > 0 || map.scopes.length > 0);
};

// Resolves specifiers for the module at `base` in a realm: an array of imResolveOne's results, one per specifier.
api.importMapResolve = (realmId, base, specifiers) => {
    const map = imMap(realmId);
    const b = imBase(base);
    const out = [];
    for (let i = 0; i < specifiers.length; i++)
        IMPush(out, map === null ? { __proto__: null, url: null, mapped: false } : imResolveOne(realmId, map, b, HostString(specifiers[i])));
    return out;
};

// The integrity metadata the import map gives a module URL ("resolve a module integrity metadata"), or '' for none.
api.importMapIntegrity = (realmId, url) => {
    const map = imMap(realmId);
    if (map === null)
        return '';
    const v = map.integrity[HostString(url)];
    return typeof v === 'string' ? v : '';
};

// ===== glue/engine/58-webgl.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: WebGL's executor (engine/platform/WebGL.cpp, docs/webgl.md). LibWeb's WebGL contexts record
// their calls as a command stream; the engine replays it with Ladybird's GPU-process executor, whose GL ES calls
// (GLFunctions, ANGLE's names) arrive here and run on a WebGL context of the segment Worker's own: one host
// OffscreenCanvas per page context, created by the glue and never reachable from page script. The answers to
// queries (getParameter, extensions, precision formats, errors, info logs) are therefore the host browser's.
//
// GL names: the engine works in GL integer names; the host in WebGL objects. Each host context keeps a table
// name -> object (and the reverse, for getParameter answers that are objects). Uniform locations get names too.
// Pointers are into the engine's linear memory; "offset" pointers (vertex attribs, indices, pixel buffers bound)
// are passed on as numbers, as WebGL takes them.
//
// Every host method is captured when the glue loads (uncurried from the prototypes), before any page script.

const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const HostWebGL1 = globalThis.WebGLRenderingContext;
const HostWebGL2 = globalThis.WebGL2RenderingContext;
// A host without these (Node tests, a fake global) has no WebGL: every capture tolerates their absence.
const webglMethodOf = (ctor, name) => (ctor && ctor.prototype && typeof ctor.prototype[name] === 'function' ? uncurryThis(ctor.prototype[name]) : null);
const webglSetterOf = (ctor, name) => {
    const d = ctor && ctor.prototype && ObjectGetOwnPropertyDescriptor(ctor.prototype, name);
    return d && d.set ? uncurryThis(d.set) : null;
};
const OffscreenCanvasGetContext = webglMethodOf(HostOffscreenCanvas, 'getContext');
const OffscreenCanvasSetWidth = webglSetterOf(HostOffscreenCanvas, 'width');
const OffscreenCanvasSetHeight = webglSetterOf(HostOffscreenCanvas, 'height');
const EventTargetAddEventListener = webglMethodOf(globalThis.EventTarget, 'addEventListener');
const EventPreventDefault = webglMethodOf(globalThis.Event, 'preventDefault');
const WebGLTypedArrayLength = uncurryThis(ObjectGetOwnPropertyDescriptor(ObjectGetPrototypeOf(Uint16Array.prototype), 'length').get);
const WeakMapGet = uncurryThis(WeakMap.prototype.get);
const WeakMapSet = uncurryThis(WeakMap.prototype.set);
const WebGLInt8Array = globalThis.Int8Array;
const WebGLInt16Array = globalThis.Int16Array;
const WebGLInt32Array = globalThis.Int32Array;
const WebGLUint8Array = globalThis.Uint8Array;
const WebGLBigInt64Array = globalThis.BigInt64Array;
const WebGLBigInt = globalThis.BigInt;
const WebGLArrayIsArray = globalThis.Array.isArray;
const WebGLImageData = globalThis.ImageData;
const WebGLUint8ClampedArray = globalThis.Uint8ClampedArray;
const WebGLTypedArraySet = uncurryThis(ObjectGetPrototypeOf(Uint8Array.prototype).set);

// The prototype methods of each host context kind, uncurried: M[name](gl, ...args).
function captureMethods(proto) {
    const methods = { __proto__: null };
    if (!proto)
        return methods;
    const names = HostReflect.ownKeys(proto);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (typeof name !== 'string')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(proto, name);
        if (d && typeof d.value === 'function')
            methods[name] = uncurryThis(d.value);
    }
    return methods;
}
const WebGL1Methods = captureMethods(HostWebGL1 && HostWebGL1.prototype);
const WebGL2Methods = captureMethods(HostWebGL2 && HostWebGL2.prototype);
// Extension objects' methods, captured on first use from the host's own prototype (page script cannot reach them:
// the host extension objects never leave the glue).
const extensionMethodCache = new WeakMap();
function extensionMethods(ext) {
    const proto = ObjectGetPrototypeOf(ext);
    let methods = WeakMapGet(extensionMethodCache, proto);
    if (!methods) {
        methods = captureMethods(proto);
        WeakMapSet(extensionMethodCache, proto, methods);
    }
    return methods;
}

const ObjectPrototypeToStringWebGL = uncurryThis(HostObject.prototype.toString);
const getterOf = (ctor, name) => {
    const d = ctor && ctor.prototype && ObjectGetOwnPropertyDescriptor(ctor.prototype, name);
    return d && d.get ? uncurryThis(d.get) : null;
};
const ActiveInfoName = getterOf(globalThis.WebGLActiveInfo, 'name');
const ActiveInfoSize = getterOf(globalThis.WebGLActiveInfo, 'size');
const ActiveInfoType = getterOf(globalThis.WebGLActiveInfo, 'type');
const PrecisionRangeMin = getterOf(globalThis.WebGLShaderPrecisionFormat, 'rangeMin');
const PrecisionRangeMax = getterOf(globalThis.WebGLShaderPrecisionFormat, 'rangeMax');
const PrecisionPrecision = getterOf(globalThis.WebGLShaderPrecisionFormat, 'precision');
const JSONQuote = (s) => {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = StringPrototypeCharCodeAtWebGL(s, i);
        if (c === 0x22 || c === 0x5C) out += '\\' + StringFromCharCode(c);
        else if (c < 0x20 || c > 0x7E) out += '\\u' + StringPrototypePadStartWebGL(NumberPrototypeToStringWebGL(c, 16), 4, '0');
        else out += StringFromCharCode(c);
    }
    return out + '"';
};
const StringPrototypeCharCodeAtWebGL = uncurryThis(HostString.prototype.charCodeAt);
const StringPrototypePadStartWebGL = uncurryThis(HostString.prototype.padStart);
const NumberPrototypeToStringWebGL = uncurryThis(HostNumber.prototype.toString);

// A host answer as JSON for the engine (patch 0064, glHostQueryCHITIN): null, booleans, numbers ({"nan":1} for NaN),
// strings, ["Float32Array", [...]] for typed arrays, plain arrays, {"info":[name,size,type]} for WebGLActiveInfo,
// {"prec":[min,max,precision]}, and {"o":name} for any other object (the engine answers objects itself).
function hostJSON(C, v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return NumberIsFinite(v) ? NumberPrototypeToStringWebGL(v) : (v !== v ? '{"nan":1}' : (v > 0 ? '{"inf":1}' : '{"inf":-1}'));
    if (typeof v === 'string') return JSONQuote(v);
    if (typeof v === 'bigint') return NumberPrototypeToStringWebGL(HostNumber(v));
    const tag = ObjectPrototypeToStringWebGL(v);
    if (WebGLIsView(v)) {
        const n = WebGLTypedArrayLength(v);
        let out = '[' + JSONQuote(StringPrototypeSliceWebGL(tag, 8, -1)) + ',[';
        for (let i = 0; i < n; i++) out += (i ? ',' : '') + hostJSON(C, v[i]);
        return out + ']]';
    }
    if (WebGLArrayIsArray(v)) {
        let out = '[';
        for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + hostJSON(C, v[i]);
        return out + ']';
    }
    if (tag === '[object WebGLActiveInfo]')
        return '{"info":[' + JSONQuote(ActiveInfoName(v)) + ',' + ActiveInfoSize(v) + ',' + ActiveInfoType(v) + ']}';
    if (tag === '[object WebGLShaderPrecisionFormat]')
        return '{"prec":[' + PrecisionRangeMin(v) + ',' + PrecisionRangeMax(v) + ',' + PrecisionPrecision(v) + ']}';
    return '{"o":' + nameOf(C, v) + '}';
}
const StringPrototypeSliceWebGL = uncurryThis(HostString.prototype.slice);

// The host calls glHostQueryCHITIN stands for, by kind (LibWeb's WebGLRenderingContextBase::HostQuery).
function hostQuery(C, kind, obj, a, b, c) {
    const gl = C.gl, M = C.M, o = object(C, obj);
    switch (kind) {
    case 1: return M.getParameter(gl, a);
    case 2: return M.getTexParameter(gl, a, b);
    case 3: return M.getBufferParameter(gl, a, b);
    case 4: return M.getRenderbufferParameter(gl, a, b);
    case 5: return M.getVertexAttrib(gl, a >>> 0, b);
    case 6: return M.getShaderPrecisionFormat(gl, a, b);
    case 7: return M.getProgramParameter(gl, o, a);
    case 8: return M.getShaderParameter(gl, o, a);
    case 9: return M.getSamplerParameter(gl, o, a);
    case 10: return M.getQueryParameter(gl, o, a);
    case 11: return M.getIndexedParameter(gl, a, b >>> 0);
    case 12: return M.getInternalformatParameter(gl, a, b, c);
    case 13: return M.getActiveUniform(gl, o, a >>> 0);
    case 14: return M.getActiveAttrib(gl, o, a >>> 0);
    case 15: return M.getTransformFeedbackVarying(gl, o, a >>> 0);
    case 16: return M.getActiveUniformBlockName(gl, o, a >>> 0);
    case 17: return M.getFramebufferAttachmentParameter(gl, a, b, c);
    case 18: return M.getUniform(gl, o, a < 0 ? null : (C.locations[a] || null));
    case 19: return M.getActiveUniformBlockParameter(gl, o, a >>> 0, b);
    case 20: return M.getQuery(gl, a, b);
    case 21: {
        const ext = C.ext.WEBGL_debug_shaders || (C.ext.WEBGL_debug_shaders = M.getExtension(gl, 'WEBGL_debug_shaders'));
        return ext ? extensionMethods(ext).getTranslatedShaderSource(ext, o) : null;
    }
    case 22: return C.extensionResult;
    default: return null;
    }
}

// {"e":"NAME","m":"name","a":[1,true,[1,2],0.5,null]} as the engine writes it (WebGLRenderingContextBase::host_extension_call).
function parseExtensionCall(text) {
    let i = 0;
    const ws = () => { while (text[i] === ' ') i++; };
    const value = () => {
        ws();
        const ch = text[i];
        if (ch === '"') {
            let out = '';
            i++;
            while (i < text.length && text[i] !== '"') out += text[i++];
            i++;
            return out;
        }
        if (ch === '[') {
            const list = [];
            i++;
            ws();
            if (text[i] === ']') { i++; return list; }
            for (;;) {
                list[list.length] = value();
                ws();
                if (text[i] === ',') { i++; continue; }
                i++;
                return list;
            }
        }
        if (StringPrototypeStartsWith(text, 'true', i)) { i += 4; return true; }
        if (StringPrototypeStartsWith(text, 'false', i)) { i += 5; return false; }
        if (StringPrototypeStartsWith(text, 'null', i)) { i += 4; return null; }
        let start = i;
        while (i < text.length && text[i] !== ',' && text[i] !== ']' && text[i] !== '}' && text[i] !== ' ') i++;
        return +StringPrototypeSliceWebGL(text, start, i);
    };
    const result = { __proto__: null, e: '', m: '', a: [] };
    i = 1; // past '{'
    for (;;) {
        ws();
        if (text[i] !== '"') break;
        const key = value();
        ws(); i++; // ':'
        result[key] = value();
        ws();
        if (text[i] === ',') { i++; continue; }
        break;
    }
    return result;
}

const webglContexts = { __proto__: null };
let nextWebGLHandle = 1;
let currentWebGL = null;

// GL ES names of extensions the engine may ask for -> WebGL names (the engine asks by WebGL name; these are kept for
// a request made by the GL name).
const GL_TO_WEBGL_EXTENSION = {
    __proto__: null,
    GL_ANGLE_instanced_arrays: 'ANGLE_instanced_arrays',
    GL_OES_vertex_array_object: 'OES_vertex_array_object',
    GL_EXT_draw_buffers: 'WEBGL_draw_buffers',
};

// Typed-array constructor for pixel data of a GL type.
function pixelArrayFor(type) {
    switch (type) {
    case 0x1400: return WebGLInt8Array;                       // BYTE
    case 0x1402: return WebGLInt16Array;                      // SHORT
    case 0x1403: case 0x8363: case 0x8033: case 0x8034:       // UNSIGNED_SHORT, 5_6_5, 4_4_4_4, 5_5_5_1
    case 0x140B: case 0x8D61: return Uint16Array;             // HALF_FLOAT, HALF_FLOAT_OES
    case 0x1404: return WebGLInt32Array;                      // INT
    case 0x1405: case 0x8368: case 0x8C3B: case 0x8C3E:       // UNSIGNED_INT, 2_10_10_10_REV, 10F_11F_11F_REV, 5_9_9_9_REV
    case 0x84FA: return Uint32Array;                          // UNSIGNED_INT_24_8
    case 0x1406: return Float32Array;                         // FLOAT
    default: return WebGLUint8Array;
    }
}

// A view of `bytes` bytes of linear memory at `ptr` as `Ctor` elements; copied when misaligned. The view goes only
// to host WebGL methods.
function memoryView(Ctor, ptr, bytes) {
    views();
    const size = Ctor.BYTES_PER_ELEMENT;
    const count = MathFloor(bytes / size);
    if (ptr % size === 0)
        return new Ctor(viewBuffer, ptr, count);
    const copy = new WebGLUint8Array(count * size);
    for (let i = 0; i < count * size; i++)
        copy[i] = u8[ptr + i];
    return new Ctor(copy.buffer, 0, count);
}

function i32View() { views(); return new WebGLInt32Array(viewBuffer); }
function f32View() { views(); return new Float32Array(viewBuffer); }

function webglCreate(version, depth, stencil, antialias, width, height, alpha, premultipliedAlpha) {
    if (!HostOffscreenCanvas || !OffscreenCanvasGetContext || !OffscreenCanvasSetWidth || (version === 2 ? !HostWebGL2 : !HostWebGL1))
        return 0;
    let canvas;
    let gl;
    try {
        canvas = new HostOffscreenCanvas(width, height);
        // Page attributes the executor carries; the drawing buffer is preserved because the engine clears it
        // itself when a non-preserving page context presents (HostWebGLContext).
        gl = OffscreenCanvasGetContext(canvas, version === 2 ? 'webgl2' : 'webgl', {
            __proto__: null, alpha: alpha !== 0, depth: !!depth, stencil: !!stencil, antialias: !!antialias,
            premultipliedAlpha: true, preserveDrawingBuffer: true,
        });
    } catch (e) {
        return 0;
    }
    if (!gl)
        return 0;
    const handle = nextWebGLHandle++;
    const C = {
        __proto__: null,
        handle, canvas, gl, version,
        premultiplied: premultipliedAlpha !== 0, // the page's premultipliedAlpha: presentation premultiplies when false
        M: version === 2 ? WebGL2Methods : WebGL1Methods,
        objects: { __proto__: null },  // name -> host object
        names: new WeakMap(),          // host object -> name
        nextName: 1,
        locations: { __proto__: null }, // location name -> WebGLUniformLocation
        nextLocation: 0,
        syncs: { __proto__: null },
        nextSync: 8,
        ext: { __proto__: null },       // enabled host extensions by WebGL name
        strings: { __proto__: null },   // GL string pointers, freed with the context
        packBuffer: 0, unpackBuffer: 0,
        mapped: null,
        lost: false,
        fresh: true,
        dirty: true,
        readOnce: false,
    };
    webglContexts[handle] = C;
    if (EventTargetAddEventListener) {
        EventTargetAddEventListener(canvas, 'webglcontextlost', (event) => {
            EventPreventDefault(event); // the host may restore it; the page's context is told either way
            C.lost = true;
            if (webglContexts[handle] && X) {
                X.ganglion_webgl_context_event(handle, 0);
                api.pump();
            }
        });
        EventTargetAddEventListener(canvas, 'webglcontextrestored', () => {
            if (webglContexts[handle] && X) {
                X.ganglion_webgl_context_event(handle, 1);
                api.pump();
            }
        });
    }
    currentWebGL = C;
    return handle;
}

function remember(C, object) {
    if (!object)
        return 0;
    const name = C.nextName++;
    C.objects[name] = object;
    WeakMapSet(C.names, object, name);
    return name;
}

function object(C, name) {
    return name ? (C.objects[name] || null) : null;
}

function nameOf(C, value) {
    if (value === null || value === undefined)
        return 0;
    return WeakMapGet(C.names, value) || 0;
}

function forget(C, name) {
    delete C.objects[name];
}

// Writes a getParameter-style answer as `kind` ('i' int32, 'u' uint32, 'f' float32, 'b' GLboolean, 'l' int64) values
// at `ptr`, at most `max` of them; returns how many it wrote.
function writeValues(C, value, kind, ptr, max) {
    views();
    let values;
    if (value === null || value === undefined)
        values = [0];
    else if (typeof value === 'boolean')
        values = [value ? 1 : 0];
    else if (typeof value === 'number')
        values = [value];
    else if (typeof value === 'object' && WebGLArrayIsArray(value))
        values = value;
    else if (typeof value === 'object' && WebGLIsView(value)) {
        const n = WebGLTypedArrayLength(value);
        values = [];
        for (let i = 0; i < n; i++)
            values[i] = value[i];
    } else if (typeof value === 'object')
        values = [nameOf(C, value)];
    else
        values = [0];
    const n = MathMin(values.length, max);
    if (kind === 'f') {
        const f = f32View();
        for (let i = 0; i < n; i++)
            f[(ptr >>> 2) + i] = +values[i];
    } else if (kind === 'b') {
        for (let i = 0; i < n; i++)
            u8[ptr + i] = values[i] ? 1 : 0;
    } else if (kind === 'l') {
        const l = new WebGLBigInt64Array(viewBuffer);
        for (let i = 0; i < n; i++)
            l[(ptr >>> 3) + i] = WebGLBigInt(typeof values[i] === 'boolean' ? (values[i] ? 1 : 0) : MathFloor(+values[i]));
    } else {
        const v = i32View();
        for (let i = 0; i < n; i++) {
            const x = values[i];
            v[(ptr >>> 2) + i] = typeof x === 'boolean' ? (x ? 1 : 0) : (kind === 'i' && typeof x === 'number' && !NumberIsFinite(x) ? 0 : x);
        }
    }
    return n;
}
const WebGLIsView = HostArrayBuffer.isView;

function setLength(ptr, n) {
    if (ptr)
        i32View()[ptr >>> 2] = n;
}

// A string into a GL out buffer: at most bufSize-1 bytes and a NUL; *length = bytes written (without the NUL).
function webglWriteString(s, bufSize, lengthPtr, out) {
    const bytes = TextEncoderPrototypeEncode(encoderUtf8, s || '');
    let n = 0;
    if (bufSize > 0 && out) {
        views();
        n = MathMin(bytes.length, bufSize - 1);
        for (let i = 0; i < n; i++)
            u8[out + i] = bytes[i];
        u8[out + n] = 0;
    }
    setLength(lengthPtr, n);
}

function cStringArray(count, ptr) {
    const v = i32View();
    const list = [];
    for (let i = 0; i < count; i++)
        list[i] = cString(v[(ptr >>> 2) + i] >>> 0);
    return list;
}

function uintArray(count, ptr) {
    const v = i32View();
    const list = [];
    for (let i = 0; i < count; i++)
        list[i] = v[(ptr >>> 2) + i] >>> 0;
    return list;
}

function utf8Length(s) {
    return s ? TextEncoderPrototypeEncode(encoderUtf8, s).length : 0;
}

// The default framebuffer, with the bindings and state the engine's own use touches saved and put back. Nothing
// here can raise a GL error the page would see.
function withDefaultFramebuffer(C, read, body) {
    const gl = C.gl, M = C.M;
    const target = C.version === 2 ? (read ? 0x8CA8 : 0x8CA9) : 0x8D40; // READ_/DRAW_FRAMEBUFFER : FRAMEBUFFER
    const binding = C.version === 2 ? (read ? 0x8CAA : 0x8CA6) : 0x8CA6;
    const previous = M.getParameter(gl, binding);
    if (previous)
        M.bindFramebuffer(gl, target, null);
    try {
        body();
    } finally {
        if (previous)
            M.bindFramebuffer(gl, target, previous);
    }
}

function addWebGLImports(env) {
    env.ganglion_host_webgl_create = webglCreate;
    env.ganglion_host_webgl_destroy = (handle) => {
        const C = webglContexts[handle];
        if (!C)
            return;
        delete webglContexts[handle];
        if (currentWebGL === C)
            currentWebGL = null;
        const strings = ObjectKeys(C.strings);
        for (let i = 0; i < strings.length; i++)
            X.ganglion_free(C.strings[strings[i]]);
        const lose = C.ext.WEBGL_lose_context || (C.M.getExtension ? C.M.getExtension(C.gl, 'WEBGL_lose_context') : null);
        // Let the host free the GPU resources now rather than at collection.
        if (lose && !C.lost) {
            try { extensionMethods(lose).loseContext(lose); } catch (e) { }
        }
    };
    env.ganglion_host_webgl_make_current = (handle) => {
        currentWebGL = webglContexts[handle] || null;
    };
    env.ganglion_host_webgl_resize = (handle, width, height) => {
        const C = webglContexts[handle];
        if (!C)
            return;
        C.dirty = true;
        OffscreenCanvasSetWidth(C.canvas, width);
        OffscreenCanvasSetHeight(C.canvas, height);
        // The context is made at 1x1 and sized right away: the viewport and scissor box start as the drawing
        // buffer's size, as when a page's context is created.
        if (C.fresh) {
            C.fresh = false;
            C.M.viewport(C.gl, 0, 0, width, height);
            C.M.scissor(C.gl, 0, 0, width, height);
        }
    };
    // Image uploads arrive converted (flipped, premultiplied by the engine): the page's unpack state is set aside.
    env.ganglion_host_webgl_bitmap_upload = (begin) => {
        const C = currentWebGL;
        if (!C)
            return;
        const gl = C.gl, M = C.M;
        if (begin) {
            C.savedUnpack = [M.getParameter(gl, 0x9240), M.getParameter(gl, 0x9241), M.getParameter(gl, 0x9243)];
            M.pixelStorei(gl, 0x9240, 0);
            M.pixelStorei(gl, 0x9241, 0);
            M.pixelStorei(gl, 0x9243, 0);
        } else if (C.savedUnpack) {
            M.pixelStorei(gl, 0x9240, C.savedUnpack[0] ? 1 : 0);
            M.pixelStorei(gl, 0x9241, C.savedUnpack[1] ? 1 : 0);
            M.pixelStorei(gl, 0x9243, C.savedUnpack[2]);
            C.savedUnpack = null;
        }
    };
    // An image source upload (HTMLImageElement, canvas, video, ImageData, ImageBitmap): the engine hands the source's
    // pixels as unpremultiplied RGBA8 and the host's own TexImageSource upload does the rest, as it does for a page:
    // the conversion to format/type, UNPACK_FLIP_Y / PREMULTIPLY_ALPHA (as the engine resolved them for this source),
    // the WebGL 2 unpack sub-rectangle and image height. call: 0 texImage2D, 1 texSubImage2D, 2 texImage3D,
    // 3 texSubImage3D; width < 0 means the source's own size (the WebGL 1 overloads).
    env.ganglion_host_webgl_tex_source = (call, target, level, internalformat, xoffset, yoffset, zoffset, width, height, depth, format, type,
        ptr, sourceWidth, sourceHeight, flipY, premultiply) => {
        const C = currentWebGL;
        if (!C)
            return;
        const gl = C.gl, M = C.M;
        let source = null;
        if (sourceWidth > 0 && sourceHeight > 0 && WebGLImageData) {
            views();
            const data = new WebGLUint8ClampedArray(sourceWidth * sourceHeight * 4);
            WebGLTypedArraySet(data, new WebGLUint8Array(viewBuffer, ptr, data.length));
            source = new WebGLImageData(data, sourceWidth, sourceHeight);
        }
        const saved = [M.getParameter(gl, 0x9240), M.getParameter(gl, 0x9241), M.getParameter(gl, 0x9243)];
        M.pixelStorei(gl, 0x9240, flipY ? 1 : 0);
        M.pixelStorei(gl, 0x9241, premultiply ? 1 : 0);
        M.pixelStorei(gl, 0x9243, 0);
        try {
            if (!source) {
                // An empty source (0x0): the same call with no pixels.
                const w = width < 0 ? 0 : width, h = height < 0 ? 0 : height;
                if (call === 0) M.texImage2D(gl, target, level, internalformat, w, h, 0, format, type, null);
                else if (call === 1) M.texSubImage2D(gl, target, level, xoffset, yoffset, w, h, format, type, null);
                else if (call === 2) M.texImage3D(gl, target, level, internalformat, w, h, depth, 0, format, type, null);
                else M.texSubImage3D(gl, target, level, xoffset, yoffset, zoffset, w, h, depth, format, type, null);
            } else if (call === 0) {
                if (width < 0) M.texImage2D(gl, target, level, internalformat, format, type, source);
                else M.texImage2D(gl, target, level, internalformat, width, height, 0, format, type, source);
            } else if (call === 1) {
                if (width < 0) M.texSubImage2D(gl, target, level, xoffset, yoffset, format, type, source);
                else M.texSubImage2D(gl, target, level, xoffset, yoffset, width, height, format, type, source);
            } else if (call === 2) {
                M.texImage3D(gl, target, level, internalformat, width, height, depth, 0, format, type, source);
            } else {
                M.texSubImage3D(gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, source);
            }
        } catch (e) {
            // The host throws only for what the engine has validated already; the error state is the host's.
        }
        M.pixelStorei(gl, 0x9240, saved[0] ? 1 : 0);
        M.pixelStorei(gl, 0x9241, saved[1] ? 1 : 0);
        M.pixelStorei(gl, 0x9243, saved[2]);
    };
    env.ganglion_host_webgl_extensions = (handle) => {
        const C = webglContexts[handle];
        if (!C)
            return 0;
        const list = C.M.getSupportedExtensions(C.gl) || [];
        let text = '';
        for (let i = 0; i < list.length; i++)
            text += (i ? '\n' : '') + list[i];
        return copyInString(text);
    };
    env.ganglion_host_webgl_clear_default = (handle) => {
        const C = webglContexts[handle];
        if (!C || C.lost)
            return;
        const gl = C.gl, M = C.M;
        const color = M.getParameter(gl, 0x0C22);    // COLOR_CLEAR_VALUE
        const depth = M.getParameter(gl, 0x0B73);    // DEPTH_CLEAR_VALUE
        const stencil = M.getParameter(gl, 0x0B91);  // STENCIL_CLEAR_VALUE
        const scissor = M.isEnabled(gl, 0x0C11);     // SCISSOR_TEST
        const colorMask = M.getParameter(gl, 0x0C23);
        const depthMask = M.getParameter(gl, 0x0B72);
        const stencilMask = M.getParameter(gl, 0x0B98);
        const stencilBackMask = M.getParameter(gl, 0x8CA5);
        withDefaultFramebuffer(C, false, () => {
            if (scissor)
                M.disable(gl, 0x0C11);
            M.colorMask(gl, true, true, true, true);
            M.depthMask(gl, true);
            M.stencilMask(gl, 0xFFFFFFFF);
            M.clearColor(gl, 0, 0, 0, 0);
            M.clearDepth(gl, 1);
            M.clearStencil(gl, 0);
            M.clear(gl, 0x4500); // COLOR | DEPTH | STENCIL
            M.clearColor(gl, color[0], color[1], color[2], color[3]);
            M.clearDepth(gl, depth);
            M.clearStencil(gl, stencil);
            M.colorMask(gl, colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
            M.depthMask(gl, depthMask);
            M.stencilMaskSeparate(gl, 0x0404, stencilMask);     // FRONT
            M.stencilMaskSeparate(gl, 0x0405, stencilBackMask); // BACK
            if (scissor)
                M.enable(gl, 0x0C11);
        });
    };
    env.ganglion_host_webgl_read_frame = (handle, ptr, pitch, width, height) => {
        const C = webglContexts[handle];
        if (!C || C.lost)
            return;
        // Nothing drawn since the last read (a presented frame whose buffer the engine has since cleared, or the
        // same frame read again): the surface keeps what it has, as Chrome keeps the presented frame for read-back.
        if (!C.dirty && C.readOnce)
            return;
        C.dirty = false;
        C.readOnce = true;
        const gl = C.gl, M = C.M;
        const pixels = new WebGLUint8Array(width * height * 4);
        withDefaultFramebuffer(C, true, () => {
            const alignment = M.getParameter(gl, 0x0D05); // PACK_ALIGNMENT
            let packBuffer = null, rowLength = 0, skipPixels = 0, skipRows = 0;
            if (C.version === 2) {
                packBuffer = M.getParameter(gl, 0x88ED); // PIXEL_PACK_BUFFER_BINDING
                rowLength = M.getParameter(gl, 0x0D02);
                skipPixels = M.getParameter(gl, 0x0D04);
                skipRows = M.getParameter(gl, 0x0D03);
                if (packBuffer) M.bindBuffer(gl, 0x88EB, null);
                if (rowLength) M.pixelStorei(gl, 0x0D02, 0);
                if (skipPixels) M.pixelStorei(gl, 0x0D04, 0);
                if (skipRows) M.pixelStorei(gl, 0x0D03, 0);
            }
            if (alignment !== 4) M.pixelStorei(gl, 0x0D05, 4);
            M.readPixels(gl, 0, 0, width, height, 0x1908, 0x1401, pixels);
            if (alignment !== 4) M.pixelStorei(gl, 0x0D05, alignment);
            if (C.version === 2) {
                if (packBuffer) M.bindBuffer(gl, 0x88EB, packBuffer);
                if (rowLength) M.pixelStorei(gl, 0x0D02, rowLength);
                if (skipPixels) M.pixelStorei(gl, 0x0D04, skipPixels);
                if (skipRows) M.pixelStorei(gl, 0x0D03, skipRows);
            }
        });
        // GL rows are bottom-up RGBA; the surface is top-down BGRA, premultiplied (as the buffer is, unless the page
        // asked for premultipliedAlpha: false, whose colours are premultiplied here as Chrome composites them).
        views();
        const premultiply = !C.premultiplied;
        for (let y = 0; y < height; y++) {
            let src = (height - 1 - y) * width * 4;
            let dst = ptr + y * pitch;
            for (let x = 0; x < width; x++, src += 4, dst += 4) {
                const a = pixels[src + 3];
                if (premultiply && a !== 255) {
                    u8[dst] = MathFloor(pixels[src + 2] * a / 255 + 0.5);
                    u8[dst + 1] = MathFloor(pixels[src + 1] * a / 255 + 0.5);
                    u8[dst + 2] = MathFloor(pixels[src] * a / 255 + 0.5);
                } else {
                    u8[dst] = pixels[src + 2];
                    u8[dst + 1] = pixels[src + 1];
                    u8[dst + 2] = pixels[src];
                }
                u8[dst + 3] = a;
            }
        }
    };

    addGLFunctions(env);

    // A host exception must not unwind through the engine's frames (it would skip C++ cleanup): every import
    // catches, says what threw once per name, and returns 0.
    const names = ObjectKeys(env);
    const reported = { __proto__: null };
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!(name[0] === 'g' && name[1] === 'l' && name[2] >= 'A' && name[2] <= 'Z') && !StringPrototypeStartsWith(name, 'ganglion_host_webgl_'))
            continue;
        const f = env[name];
        // Anything but a query may change the drawing buffer: the next frame read takes it.
        const changes = name[1] === 'l' && !StringPrototypeStartsWith(name, 'glGet') && !StringPrototypeStartsWith(name, 'glIs') && name !== 'glCheckFramebufferStatus' && name !== 'glHostQueryCHITIN' && name !== 'glFinish';
        env[name] = function () {
            if (changes && currentWebGL)
                currentWebGL.dirty = true;
            try {
                return ReflectApply(f, null, arguments);
            } catch (e) {
                if (!reported[name]) {
                    reported[name] = true;
                    hostConsoleError(hostConsole, 'webgl: ' + name + ' threw ' + (e && e.name) + ': ' + (e && e.message));
                }
                return 0;
            }
        };
    }
}

// --- GL ES entry points (Ladybird's GLFunctions.json) ------------------------------------------------------------

function addGLFunctions(env) {
    const cur = () => currentWebGL;
    // Calls with only scalar and object arguments: [GL name, WebGL method, argument kinds] ('n' number, 'o' object).
    const simple = [
        ['glActiveTexture', 'activeTexture', 'n'],
        ['glAttachShader', 'attachShader', 'oo'],
        ['glBeginQuery', 'beginQuery', 'no'],
        ['glBeginTransformFeedback', 'beginTransformFeedback', 'n'],
        ['glBindBufferBase', 'bindBufferBase', 'nno'],
        ['glBindBufferRange', 'bindBufferRange', 'nnonn'],
        ['glBindFramebuffer', 'bindFramebuffer', 'no'],
        ['glBindRenderbuffer', 'bindRenderbuffer', 'no'],
        ['glBindSampler', 'bindSampler', 'no'],
        ['glBindTexture', 'bindTexture', 'no'],
        ['glBindTransformFeedback', 'bindTransformFeedback', 'no'],
        ['glBindVertexArray', 'bindVertexArray', 'o'],
        ['glBlendColor', 'blendColor', 'nnnn'],
        ['glBlendEquation', 'blendEquation', 'n'],
        ['glBlendEquationSeparate', 'blendEquationSeparate', 'nn'],
        ['glBlendFunc', 'blendFunc', 'nn'],
        ['glBlendFuncSeparate', 'blendFuncSeparate', 'nnnn'],
        ['glBlitFramebuffer', 'blitFramebuffer', 'nnnnnnnnnn'],
        ['glClear', 'clear', 'n'],
        ['glClearBufferfi', 'clearBufferfi', 'nnnn'],
        ['glClearColor', 'clearColor', 'nnnn'],
        ['glClearDepthf', 'clearDepth', 'n'],
        ['glClearStencil', 'clearStencil', 'n'],
        ['glColorMask', 'colorMask', 'nnnn'],
        ['glCompileShader', 'compileShader', 'o'],
        ['glCopyBufferSubData', 'copyBufferSubData', 'nnnnn'],
        ['glCopyTexImage2D', 'copyTexImage2D', 'nnnnnnnn'],
        ['glCopyTexSubImage2D', 'copyTexSubImage2D', 'nnnnnnnn'],
        ['glCopyTexSubImage3D', 'copyTexSubImage3D', 'nnnnnnnnn'],
        ['glCullFace', 'cullFace', 'n'],
        ['glDepthFunc', 'depthFunc', 'n'],
        ['glDepthMask', 'depthMask', 'n'],
        ['glDepthRangef', 'depthRange', 'nn'],
        ['glDetachShader', 'detachShader', 'oo'],
        ['glDisable', 'disable', 'n'],
        ['glDisableVertexAttribArray', 'disableVertexAttribArray', 'n'],
        ['glDrawArrays', 'drawArrays', 'nnn'],
        ['glDrawArraysInstanced', 'drawArraysInstanced', 'nnnn'],
        ['glDrawElements', 'drawElements', 'nnnn'],
        ['glDrawElementsInstanced', 'drawElementsInstanced', 'nnnnn'],
        ['glDrawRangeElements', 'drawRangeElements', 'nnnnnn'],
        ['glEnable', 'enable', 'n'],
        ['glEnableVertexAttribArray', 'enableVertexAttribArray', 'n'],
        ['glEndQuery', 'endQuery', 'n'],
        ['glEndTransformFeedback', 'endTransformFeedback', ''],
        ['glFlush', 'flush', ''],
        ['glFramebufferRenderbuffer', 'framebufferRenderbuffer', 'nnno'],
        ['glFramebufferTexture2D', 'framebufferTexture2D', 'nnnon'],
        ['glFramebufferTextureLayer', 'framebufferTextureLayer', 'nnonn'],
        ['glFrontFace', 'frontFace', 'n'],
        ['glGenerateMipmap', 'generateMipmap', 'n'],
        ['glHint', 'hint', 'nn'],
        ['glLineWidth', 'lineWidth', 'n'],
        ['glLinkProgram', 'linkProgram', 'o'],
        ['glPauseTransformFeedback', 'pauseTransformFeedback', ''],
        ['glPixelStorei', 'pixelStorei', 'nn'],
        ['glPolygonOffset', 'polygonOffset', 'nn'],
        ['glReadBuffer', 'readBuffer', 'n'],
        ['glRenderbufferStorage', 'renderbufferStorage', 'nnnn'],
        ['glRenderbufferStorageMultisample', 'renderbufferStorageMultisample', 'nnnnn'],
        ['glResumeTransformFeedback', 'resumeTransformFeedback', ''],
        ['glSampleCoverage', 'sampleCoverage', 'nn'],
        ['glSamplerParameterf', 'samplerParameterf', 'onn'],
        ['glSamplerParameteri', 'samplerParameteri', 'onn'],
        ['glScissor', 'scissor', 'nnnn'],
        ['glStencilFunc', 'stencilFunc', 'nnn'],
        ['glStencilFuncSeparate', 'stencilFuncSeparate', 'nnnn'],
        ['glStencilMask', 'stencilMask', 'n'],
        ['glStencilMaskSeparate', 'stencilMaskSeparate', 'nn'],
        ['glStencilOp', 'stencilOp', 'nnn'],
        ['glStencilOpSeparate', 'stencilOpSeparate', 'nnnn'],
        ['glTexParameterf', 'texParameterf', 'nnn'],
        ['glTexParameteri', 'texParameteri', 'nnn'],
        ['glTexStorage2D', 'texStorage2D', 'nnnnn'],
        ['glTexStorage3D', 'texStorage3D', 'nnnnnn'],
        ['glUniformBlockBinding', 'uniformBlockBinding', 'onn'],
        ['glUseProgram', 'useProgram', 'o'],
        ['glValidateProgram', 'validateProgram', 'o'],
        ['glVertexAttrib1f', 'vertexAttrib1f', 'nn'],
        ['glVertexAttrib2f', 'vertexAttrib2f', 'nnn'],
        ['glVertexAttrib3f', 'vertexAttrib3f', 'nnnn'],
        ['glVertexAttrib4f', 'vertexAttrib4f', 'nnnnn'],
        ['glVertexAttribDivisor', 'vertexAttribDivisor', 'nn'],
        ['glVertexAttribI4i', 'vertexAttribI4i', 'nnnnn'],
        ['glVertexAttribI4ui', 'vertexAttribI4ui', 'nnnnn'],
        ['glVertexAttribIPointer', 'vertexAttribIPointer', 'nnnnn'],
        ['glVertexAttribPointer', 'vertexAttribPointer', 'nnnnnn'],
        ['glViewport', 'viewport', 'nnnn'],
    ];
    for (let i = 0; i < simple.length; i++) {
        const [glName, method, kinds] = simple[i];
        const arity = kinds.length;
        env[glName] = (a, b, c, d, e, f, g, h, k, l) => {
            const C = cur();
            if (!C)
                return;
            const args = [a, b, c, d, e, f, g, h, k, l];
            const call = [C.gl];
            for (let j = 0; j < arity; j++) {
                let v = args[j];
                if (kinds[j] === 'o')
                    v = object(C, v);
                else if (typeof v === 'bigint')
                    v = HostNumber(v);
                call[j + 1] = v;
            }
            ReflectApply(C.M[method], null, call);
        };
    }
    // GLuint parameters arrive as signed i32: masks and unsigned values are reinterpreted.
    env.glStencilMask = (mask) => { const C = cur(); if (C) C.M.stencilMask(C.gl, mask >>> 0); };
    env.glStencilMaskSeparate = (face, mask) => { const C = cur(); if (C) C.M.stencilMaskSeparate(C.gl, face, mask >>> 0); };
    env.glStencilFunc = (func, ref, mask) => { const C = cur(); if (C) C.M.stencilFunc(C.gl, func, ref, mask >>> 0); };
    env.glStencilFuncSeparate = (face, func, ref, mask) => { const C = cur(); if (C) C.M.stencilFuncSeparate(C.gl, face, func, ref, mask >>> 0); };
    env.glVertexAttribI4ui = (index, x, y, z, w) => { const C = cur(); if (C) C.M.vertexAttribI4ui(C.gl, index, x >>> 0, y >>> 0, z >>> 0, w >>> 0); };
    env.glDrawRangeElements = (mode, start, end, count, type, offset) => { const C = cur(); if (C) C.M.drawRangeElements(C.gl, mode, start >>> 0, end >>> 0, count, type, offset); };

    env.glBindBuffer = (target, name) => {
        const C = cur();
        if (!C)
            return;
        C.M.bindBuffer(C.gl, target, object(C, name));
        if (target === 0x88EB) C.packBuffer = name;      // PIXEL_PACK_BUFFER
        if (target === 0x88EC) C.unpackBuffer = name;    // PIXEL_UNPACK_BUFFER
    };
    env.glBindAttribLocation = (program, index, namePtr) => { const C = cur(); if (C) C.M.bindAttribLocation(C.gl, object(C, program), index, cString(namePtr)); };

    // Object creation and deletion.
    const gen = (glName, create) => {
        env[glName] = (n, ptr) => {
            const C = cur();
            const v = i32View();
            for (let i = 0; i < n; i++)
                v[(ptr >>> 2) + i] = C ? remember(C, C.M[create](C.gl)) : 0;
        };
    };
    gen('glGenBuffers', 'createBuffer');
    gen('glGenFramebuffers', 'createFramebuffer');
    gen('glGenQueries', 'createQuery');
    gen('glGenRenderbuffers', 'createRenderbuffer');
    gen('glGenSamplers', 'createSampler');
    gen('glGenTextures', 'createTexture');
    gen('glGenTransformFeedbacks', 'createTransformFeedback');
    gen('glGenVertexArrays', 'createVertexArray');
    const del = (glName, method) => {
        env[glName] = (n, ptr) => {
            const C = cur();
            if (!C)
                return;
            const names = uintArray(n, ptr);
            for (let i = 0; i < n; i++) {
                const o = object(C, names[i]);
                C.M[method](C.gl, o);
                if (o)
                    forget(C, names[i]);
            }
        };
    };
    del('glDeleteBuffers', 'deleteBuffer');
    del('glDeleteFramebuffers', 'deleteFramebuffer');
    del('glDeleteQueries', 'deleteQuery');
    del('glDeleteRenderbuffers', 'deleteRenderbuffer');
    del('glDeleteSamplers', 'deleteSampler');
    del('glDeleteTextures', 'deleteTexture');
    del('glDeleteTransformFeedbacks', 'deleteTransformFeedback');
    del('glDeleteVertexArrays', 'deleteVertexArray');
    env.glCreateProgram = () => { const C = cur(); return C ? remember(C, C.M.createProgram(C.gl)) : 0; };
    env.glCreateShader = (type) => { const C = cur(); return C ? remember(C, C.M.createShader(C.gl, type)) : 0; };
    // A deleted program or shader stays alive (and named) while attached or in use; the host decides.
    env.glDeleteProgram = (name) => { const C = cur(); if (C) C.M.deleteProgram(C.gl, object(C, name)); };
    env.glDeleteShader = (name) => { const C = cur(); if (C) C.M.deleteShader(C.gl, object(C, name)); };

    // WebGL 1 extension entry points.
    const extCall = (extName, method) => (...args) => {
        const C = cur();
        if (!C)
            return 0;
        const ext = C.ext[extName];
        if (!ext)
            return 0;
        const call = [ext];
        for (let i = 0; i < args.length; i++)
            call[i + 1] = args[i];
        return ReflectApply(extensionMethods(ext)[method], null, call);
    };
    env.glGenVertexArraysOES = (n, ptr) => {
        const C = cur();
        const v = i32View();
        const ext = C && C.ext.OES_vertex_array_object;
        for (let i = 0; i < n; i++)
            v[(ptr >>> 2) + i] = ext ? remember(C, extensionMethods(ext).createVertexArrayOES(ext)) : 0;
    };
    env.glDeleteVertexArraysOES = (n, ptr) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        if (!ext)
            return;
        const names = uintArray(n, ptr);
        for (let i = 0; i < n; i++)
            extensionMethods(ext).deleteVertexArrayOES(ext, object(C, names[i]));
    };
    env.glBindVertexArrayOES = (name) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        if (ext)
            extensionMethods(ext).bindVertexArrayOES(ext, object(C, name));
    };
    env.glIsVertexArrayOES = (name) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        return ext && extensionMethods(ext).isVertexArrayOES(ext, object(C, name)) ? 1 : 0;
    };
    env.glDrawArraysInstancedANGLE = extCall('ANGLE_instanced_arrays', 'drawArraysInstancedANGLE');
    env.glDrawElementsInstancedANGLE = extCall('ANGLE_instanced_arrays', 'drawElementsInstancedANGLE');
    env.glVertexAttribDivisorANGLE = extCall('ANGLE_instanced_arrays', 'vertexAttribDivisorANGLE');
    env.glDrawBuffersEXT = (n, ptr) => {
        const C = cur();
        const ext = C && C.ext.WEBGL_draw_buffers;
        if (ext)
            extensionMethods(ext).drawBuffersWEBGL(ext, uintArray(n, ptr));
    };
    env.glRequestExtensionANGLE = (namePtr) => {
        const C = cur();
        if (!C)
            return;
        let name = cString(namePtr);
        name = GL_TO_WEBGL_EXTENSION[name] || name;
        if (C.ext[name])
            return;
        const ext = C.M.getExtension(C.gl, name);
        if (ext)
            C.ext[name] = ext;
    };

    // Data uploads.
    env.glBufferData = (target, size, ptr, usage) => {
        const C = cur();
        if (!C)
            return;
        if (ptr)
            C.M.bufferData(C.gl, target, memoryView(WebGLUint8Array, ptr, size), usage);
        else
            C.M.bufferData(C.gl, target, size, usage);
    };
    env.glBufferSubData = (target, offset, size, ptr) => {
        const C = cur();
        if (C)
            C.M.bufferSubData(C.gl, target, offset, memoryView(WebGLUint8Array, ptr, size));
    };
    const pixels = (C, type, bufSize, ptr) => {
        if (C.unpackBuffer)
            return ptr; // an offset into the bound PIXEL_UNPACK_BUFFER
        if (!ptr)
            return null;
        return memoryView(pixelArrayFor(type), ptr, bufSize);
    };
    env.glTexImage2DRobustANGLE = (target, level, internalformat, width, height, border, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texImage2D(C.gl, target, level, internalformat, width, height, border, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexSubImage2DRobustANGLE = (target, level, xoffset, yoffset, width, height, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexImage3DRobustANGLE = (target, level, internalformat, width, height, depth, border, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texImage3D(C.gl, target, level, internalformat, width, height, depth, border, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexSubImage3DRobustANGLE = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels(C, type, bufSize, ptr));
    };
    const compressed = (C, imageSize, ptr) => C.unpackBuffer ? null : memoryView(WebGLUint8Array, ptr, imageSize);
    env.glCompressedTexImage2DRobustANGLE = (target, level, internalformat, width, height, border, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexImage2D(C.gl, target, level, internalformat, width, height, border, imageSize, ptr);
        else
            C.M.compressedTexImage2D(C.gl, target, level, internalformat, width, height, border, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexSubImage2DRobustANGLE = (target, level, xoffset, yoffset, width, height, format, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, imageSize, ptr);
        else
            C.M.compressedTexSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexImage3DRobustANGLE = (target, level, internalformat, width, height, depth, border, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexImage3D(C.gl, target, level, internalformat, width, height, depth, border, imageSize, ptr);
        else
            C.M.compressedTexImage3D(C.gl, target, level, internalformat, width, height, depth, border, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexSubImage3DRobustANGLE = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, ptr);
        else
            C.M.compressedTexSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, compressed(C, imageSize, ptr));
    };
    env.glReadPixelsRobustANGLE = (x, y, width, height, format, type, bufSize, lengthPtr, columnsPtr, rowsPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.packBuffer)
            C.M.readPixels(C.gl, x, y, width, height, format, type, ptr);
        else
            C.M.readPixels(C.gl, x, y, width, height, format, type, memoryView(pixelArrayFor(type), ptr, bufSize));
        setLength(lengthPtr, bufSize);
        setLength(columnsPtr, width);
        setLength(rowsPtr, height);
    };

    // Uniforms and vertex attributes.
    const location = (C, l) => l < 0 ? null : (C.locations[l] || null);
    for (const n of [1, 2, 3, 4]) {
        for (const [suffix, Ctor] of [['f', Float32Array], ['i', WebGLInt32Array], ['ui', Uint32Array]]) {
            const method = 'uniform' + n + suffix;
            env['glUniform' + n + suffix] = (l, a, b, c, d) => {
                const C = cur();
                if (!C)
                    return;
                const args = [C.gl, location(C, l), a, b, c, d];
                if (suffix === 'ui')
                    for (let i = 2; i < 6; i++) args[i] = args[i] >>> 0;
                args.length = 2 + n;
                ReflectApply(C.M[method], null, args);
            };
            env['glUniform' + n + suffix + 'v'] = (l, count, ptr) => {
                const C = cur();
                if (C)
                    C.M[method + 'v'](C.gl, location(C, l), memoryView(Ctor, ptr, count * n * 4));
            };
        }
    }
    for (const [suffix, size] of [['2', 4], ['3', 9], ['4', 16], ['2x3', 6], ['2x4', 8], ['3x2', 6], ['3x4', 12], ['4x2', 8], ['4x3', 12]]) {
        const method = 'uniformMatrix' + suffix + 'fv';
        env['glUniformMatrix' + suffix + 'fv'] = (l, count, transpose, ptr) => {
            const C = cur();
            if (C)
                C.M[method](C.gl, location(C, l), !!transpose, memoryView(Float32Array, ptr, count * size * 4));
        };
    }
    for (const n of [1, 2, 3, 4]) {
        const method = 'vertexAttrib' + n + 'fv';
        env['glVertexAttrib' + n + 'fv'] = (index, ptr) => {
            const C = cur();
            if (C)
                C.M[method](C.gl, index, memoryView(Float32Array, ptr, n * 4));
        };
    }
    env.glVertexAttribI4iv = (index, ptr) => { const C = cur(); if (C) C.M.vertexAttribI4iv(C.gl, index, memoryView(WebGLInt32Array, ptr, 16)); };
    env.glVertexAttribI4uiv = (index, ptr) => { const C = cur(); if (C) C.M.vertexAttribI4uiv(C.gl, index, memoryView(Uint32Array, ptr, 16)); };
    env.glClearBufferfv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferfv(C.gl, buffer, drawbuffer, memoryView(Float32Array, ptr, buffer === 0x1801 ? 4 : 16)); };
    env.glClearBufferiv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferiv(C.gl, buffer, drawbuffer, memoryView(WebGLInt32Array, ptr, buffer === 0x1802 ? 4 : 16)); };
    env.glClearBufferuiv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferuiv(C.gl, buffer, drawbuffer, memoryView(Uint32Array, ptr, 16)); };
    env.glDrawBuffers = (n, ptr) => { const C = cur(); if (C) C.M.drawBuffers(C.gl, uintArray(n, ptr)); };
    env.glInvalidateFramebuffer = (target, n, ptr) => { const C = cur(); if (C) C.M.invalidateFramebuffer(C.gl, target, uintArray(n, ptr)); };
    env.glInvalidateSubFramebuffer = (target, n, ptr, x, y, width, height) => { const C = cur(); if (C) C.M.invalidateSubFramebuffer(C.gl, target, uintArray(n, ptr), x, y, width, height); };

    // Shaders and programs.
    env.glShaderSource = (shader, count, stringsPtr, lengthsPtr) => {
        const C = cur();
        if (!C)
            return;
        const v = i32View();
        let source = '';
        for (let i = 0; i < count; i++) {
            const p = v[(stringsPtr >>> 2) + i] >>> 0;
            const len = lengthsPtr ? v[(lengthsPtr >>> 2) + i] : -1;
            source += len >= 0 ? bytesToString(p, len) : cString(p);
        }
        C.M.shaderSource(C.gl, object(C, shader), source);
    };
    env.glTransformFeedbackVaryings = (program, count, ptr, mode) => {
        const C = cur();
        if (C)
            C.M.transformFeedbackVaryings(C.gl, object(C, program), cStringArray(count, ptr), mode);
    };
    env.glGetAttribLocation = (program, namePtr) => { const C = cur(); return C ? C.M.getAttribLocation(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetFragDataLocation = (program, namePtr) => { const C = cur(); return C ? C.M.getFragDataLocation(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetUniformBlockIndex = (program, namePtr) => { const C = cur(); return C ? C.M.getUniformBlockIndex(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetUniformLocation = (program, namePtr) => {
        const C = cur();
        if (!C)
            return -1;
        const l = C.M.getUniformLocation(C.gl, object(C, program), cString(namePtr));
        if (!l)
            return -1;
        const name = C.nextLocation++;
        C.locations[name] = l;
        return name;
    };
    env.glGetUniformIndices = (program, count, namesPtr, outPtr) => {
        const C = cur();
        if (!C)
            return;
        const indices = C.M.getUniformIndices(C.gl, object(C, program), cStringArray(count, namesPtr));
        const v = i32View();
        for (let i = 0; i < count; i++)
            v[(outPtr >>> 2) + i] = indices ? indices[i] : -1;
    };
    // GL's *_LENGTH queries have no WebGL form; they are what the strings give.
    const programLengths = (C, program, pname) => {
        const p = object(C, program);
        let max = 0;
        if (pname === 0x8B84) // INFO_LOG_LENGTH
            return (s => s ? utf8Length(s) + 1 : 0)(C.M.getProgramInfoLog(C.gl, p));
        if (pname === 0x8B87 || pname === 0x8B8A || pname === 0x8C76 || pname === 0x8A35) {
            const countPname = { __proto__: null, 0x8B87: 0x8B86, 0x8B8A: 0x8B89, 0x8C76: 0x8C83, 0x8A35: 0x8A36 }[pname];
            const count = C.M.getProgramParameter(C.gl, p, countPname) || 0;
            for (let i = 0; i < count; i++) {
                let name = '';
                if (pname === 0x8B87) { const info = C.M.getActiveUniform(C.gl, p, i); name = info && info.name; }
                else if (pname === 0x8B8A) { const info = C.M.getActiveAttrib(C.gl, p, i); name = info && info.name; }
                else if (pname === 0x8C76) { const info = C.M.getTransformFeedbackVarying(C.gl, p, i); name = info && info.name; }
                else name = C.M.getActiveUniformBlockName(C.gl, p, i);
                max = MathMax(max, utf8Length(name) + 1);
            }
            return max;
        }
        return C.M.getProgramParameter(C.gl, p, pname);
    };
    env.glGetProgramiv = (program, pname, ptr) => { const C = cur(); if (C) writeValues(C, programLengths(C, program, pname), 'i', ptr, 1); };
    env.glGetProgramivRobustANGLE = (program, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, programLengths(C, program, pname), 'i', ptr, bufSize));
    };
    const shaderParameter = (C, shader, pname) => {
        const s = object(C, shader);
        if (pname === 0x8B84) { const log = C.M.getShaderInfoLog(C.gl, s); return log ? utf8Length(log) + 1 : 0; }
        if (pname === 0x8B88) { const src = C.M.getShaderSource(C.gl, s); return src ? utf8Length(src) + 1 : 0; }
        return C.M.getShaderParameter(C.gl, s, pname);
    };
    env.glGetShaderiv = (shader, pname, ptr) => { const C = cur(); if (C) writeValues(C, shaderParameter(C, shader, pname), 'i', ptr, 1); };
    env.glGetShaderivRobustANGLE = (shader, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, shaderParameter(C, shader, pname), 'i', ptr, bufSize));
    };
    env.glGetProgramInfoLog = (program, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getProgramInfoLog(C.gl, object(C, program)), bufSize, lengthPtr, out); };
    env.glGetShaderInfoLog = (shader, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getShaderInfoLog(C.gl, object(C, shader)), bufSize, lengthPtr, out); };
    env.glGetShaderSource = (shader, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getShaderSource(C.gl, object(C, shader)), bufSize, lengthPtr, out); };
    const activeInfo = (method) => (program, index, bufSize, lengthPtr, sizePtr, typePtr, out) => {
        const C = cur();
        if (!C)
            return;
        const info = C.M[method](C.gl, object(C, program), index >>> 0);
        const v = i32View();
        if (sizePtr) v[sizePtr >>> 2] = info ? info.size : 0;
        if (typePtr) v[typePtr >>> 2] = info ? info.type : 0;
        webglWriteString(info ? info.name : '', bufSize, lengthPtr, out);
    };
    env.glGetActiveAttrib = activeInfo('getActiveAttrib');
    env.glGetActiveUniform = activeInfo('getActiveUniform');
    env.glGetActiveUniformBlockName = (program, index, bufSize, lengthPtr, out) => {
        const C = cur();
        if (C)
            webglWriteString(C.M.getActiveUniformBlockName(C.gl, object(C, program), index >>> 0), bufSize, lengthPtr, out);
    };
    env.glGetActiveUniformBlockivRobustANGLE = (program, index, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        const p = object(C, program);
        let value;
        if (pname === 0x8A41) // UNIFORM_BLOCK_NAME_LENGTH
            value = (n => n === null ? 0 : utf8Length(n) + 1)(C.M.getActiveUniformBlockName(C.gl, p, index >>> 0));
        else
            value = C.M.getActiveUniformBlockParameter(C.gl, p, index >>> 0, pname);
        setLength(lengthPtr, writeValues(C, value, 'i', ptr, bufSize));
    };
    env.glGetActiveUniformsiv = (program, count, indicesPtr, pname, ptr) => {
        const C = cur();
        if (!C)
            return;
        let value;
        if (pname === 0x8A39) { // UNIFORM_NAME_LENGTH
            const indices = uintArray(count, indicesPtr);
            value = [];
            for (let i = 0; i < count; i++) {
                const info = C.M.getActiveUniform(C.gl, object(C, program), indices[i]);
                value[i] = info ? utf8Length(info.name) + 1 : 0;
            }
        } else {
            value = C.M.getActiveUniforms(C.gl, object(C, program), uintArray(count, indicesPtr), pname);
        }
        writeValues(C, value, 'i', ptr, count);
    };
    env.glGetShaderPrecisionFormat = (shadertype, precisiontype, rangePtr, precisionPtr) => {
        const C = cur();
        const v = i32View();
        const f = C ? C.M.getShaderPrecisionFormat(C.gl, shadertype, precisiontype) : null;
        v[rangePtr >>> 2] = f ? f.rangeMin : 0;
        v[(rangePtr >>> 2) + 1] = f ? f.rangeMax : 0;
        v[precisionPtr >>> 2] = f ? f.precision : 0;
    };

    // State queries.
    env.glGetError = () => { const C = cur(); return C ? C.M.getError(C.gl) : 0; };
    env.glFinish = () => { const C = cur(); if (C) C.M.finish(C.gl); };
    env.glCheckFramebufferStatus = (target) => { const C = cur(); return C ? C.M.checkFramebufferStatus(C.gl, target) : 0; };
    env.glIsEnabled = (cap) => { const C = cur(); return C && C.M.isEnabled(C.gl, cap) ? 1 : 0; };
    const is = (glName, method) => { env[glName] = (name) => { const C = cur(); return C && C.M[method](C.gl, object(C, name)) ? 1 : 0; }; };
    is('glIsBuffer', 'isBuffer');
    is('glIsFramebuffer', 'isFramebuffer');
    is('glIsProgram', 'isProgram');
    is('glIsRenderbuffer', 'isRenderbuffer');
    is('glIsShader', 'isShader');
    is('glIsTexture', 'isTexture');
    is('glIsVertexArray', 'isVertexArray');
    is('glIsQuery', 'isQuery');
    is('glIsSampler', 'isSampler');
    is('glIsTransformFeedback', 'isTransformFeedback');
    env.glIsSync = (handle) => { const C = cur(); return C && C.M.isSync(C.gl, C.syncs[handle] || null) ? 1 : 0; };
    const getv = (glName, kind, query) => {
        env[glName] = (a, b, c, d, e) => {
            const C = cur();
            if (!C)
                return;
            // (pname, bufSize, length*, data*) or (target, pname, bufSize, length*, data*)
            const two = query.length === 3; // (C, target, pname) queries take one argument more
            const value = two ? query(C, a, b) : query(C, a);
            const bufSize = two ? c : b, lengthPtr = two ? d : c, ptr = two ? e : d;
            setLength(lengthPtr, writeValues(C, value, kind, ptr, bufSize));
        };
    };
    const parameter = (C, pname) => C.M.getParameter(C.gl, pname);
    getv('glGetIntegervRobustANGLE', 'i', parameter);
    getv('glGetFloatvRobustANGLE', 'f', parameter);
    getv('glGetBooleanvRobustANGLE', 'b', parameter);
    getv('glGetInteger64vRobustANGLE', 'l', parameter);
    getv('glGetBufferParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getBufferParameter(C.gl, target, pname));
    getv('glGetRenderbufferParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getRenderbufferParameter(C.gl, target, pname));
    getv('glGetTexParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getTexParameter(C.gl, target, pname));
    getv('glGetTexParameterfvRobustANGLE', 'f', (C, target, pname) => C.M.getTexParameter(C.gl, target, pname));
    getv('glGetVertexAttribivRobustANGLE', 'i', (C, index, pname) => C.M.getVertexAttrib(C.gl, index, pname));
    getv('glGetVertexAttribfvRobustANGLE', 'f', (C, index, pname) => C.M.getVertexAttrib(C.gl, index, pname));
    getv('glGetQueryObjectuivRobustANGLE', 'u', (C, name, pname) => C.M.getQueryParameter(C.gl, object(C, name), pname));
    env.glGetVertexAttribPointervRobustANGLE = (index, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        i32View()[ptr >>> 2] = C.M.getVertexAttribOffset(C.gl, index, pname);
        setLength(lengthPtr, 1);
    };
    env.glGetInternalformativRobustANGLE = (target, internalformat, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        let value;
        if (pname === 0x9380) { // NUM_SAMPLE_COUNTS: the length of SAMPLES
            const samples = C.M.getInternalformatParameter(C.gl, target, internalformat, 0x80A9);
            value = samples ? WebGLTypedArrayLength(samples) : 0;
        } else {
            value = C.M.getInternalformatParameter(C.gl, target, internalformat, pname);
        }
        setLength(lengthPtr, writeValues(C, value, 'i', ptr, bufSize));
    };
    env.glGetString = (name) => {
        const C = cur();
        if (!C)
            return 0;
        if (C.strings[name])
            return C.strings[name];
        let value;
        if (name === 0x1F03) { // EXTENSIONS
            const list = C.M.getSupportedExtensions(C.gl) || [];
            value = '';
            for (let i = 0; i < list.length; i++)
                value += (i ? ' ' : '') + list[i];
        } else {
            value = C.M.getParameter(C.gl, name);
        }
        if (typeof value !== 'string')
            return 0;
        // The unmasked strings follow the extension's state; the others never change.
        const ptr = copyInString(value);
        if (name !== 0x9245 && name !== 0x9246)
            C.strings[name] = ptr;
        else
            C.strings['u' + name + '_' + C.nextName++] = ptr;
        return ptr;
    };

    // A host extension method (patch 0064's generated extension interfaces): {"e", "m", "a"}. Arguments are numbers,
    // booleans and arrays of numbers, parsed by hand (the page can reach JSON).
    env.glHostExtensionCallCHITIN = (jsonPtr) => {
        const C = cur();
        if (!C)
            return;
        const call = parseExtensionCall(cString(jsonPtr));
        // The context's own unpackColorSpace (LibWeb's setter), in order with the uploads it applies to.
        if (call.e === '@context') {
            if (call.m === 'unpackColorSpace')
                C.gl.unpackColorSpace = call.a[0];
            return;
        }
        const ext = C.ext[call.e];
        C.extensionResult = null;
        if (!ext)
            return;
        const method = extensionMethods(ext)[call.m];
        if (!method)
            return;
        const args = [ext];
        // "@<name>" is a WebGL object by its GL name (OVR_multiview2's texture).
        for (let i = 0; i < call.a.length; i++) {
            const a = call.a[i];
            args[i + 1] = typeof a === 'string' && a[0] === '@' ? object(C, +StringPrototypeSliceWebGL(a, 1)) : a;
        }
        C.extensionResult = ReflectApply(method, null, args);
    };
    env.glHostQueryCHITIN = (kind, obj, a, b, c, bufSize, lengthPtr, out) => {
        const C = cur();
        webglWriteString(C ? hostJSON(C, hostQuery(C, kind, obj, a, b, c)) : 'null', bufSize, lengthPtr, out);
    };

    // Buffers mapped for reading (getBufferSubData).
    env.glMapBufferRange = (target, offset, length, access) => {
        const C = cur();
        if (!C || C.mapped)
            return 0;
        const ptr = X.ganglion_alloc(length > 0 ? length : 1);
        C.M.getBufferSubData(C.gl, target, offset, memoryView(WebGLUint8Array, ptr, length));
        C.mapped = ptr;
        return ptr;
    };
    env.glUnmapBuffer = (target) => {
        const C = cur();
        if (!C || !C.mapped)
            return 0;
        X.ganglion_free(C.mapped);
        C.mapped = null;
        return 1;
    };

    // Sync objects: GLsync is a handle the glue gives out.
    env.glFenceSync = (condition, flags) => {
        const C = cur();
        if (!C)
            return 0;
        const sync = C.M.fenceSync(C.gl, condition, flags);
        if (!sync)
            return 0;
        const handle = C.nextSync;
        C.nextSync += 8;
        C.syncs[handle] = sync;
        return handle;
    };
    env.glDeleteSync = (handle) => {
        const C = cur();
        if (!C)
            return;
        C.M.deleteSync(C.gl, C.syncs[handle] || null);
        delete C.syncs[handle];
    };
    env.glClientWaitSync = (handle, flags, timeout) => {
        const C = cur();
        return C ? C.M.clientWaitSync(C.gl, C.syncs[handle] || null, flags, HostNumber(timeout)) : 0x911D; // WAIT_FAILED
    };
    env.glWaitSync = (handle, flags, timeout) => {
        const C = cur();
        if (C)
            C.M.waitSync(C.gl, C.syncs[handle] || null, flags, HostNumber(WebGLBigInt.asIntN(64, timeout)));
    };
    env.glGetSynciv = (handle, pname, count, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, C.M.getSyncParameter(C.gl, C.syncs[handle] || null, pname), 'i', ptr, count));
    };
}

// ===== glue/engine/90-boot.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: boot. Instantiates ganglion.wasm with the imports of 20-wasi.js and 30-host.js,
// built from the module's own import list so that a name nothing here provides fails at instantiation
// (loudly, with its name) instead of at the first call.

const WebAssemblyModuleImports = HostWebAssembly.Module.imports;

// invoke_<sig>(index, ...args): calls table[index] and turns a longjmp (a thrown number) into setThrew.
function makeInvoke(signature) {
    return function invoke(index, ...args) {
        const sp = X.emscripten_stack_get_current();
        try {
            return ReflectApply(TableGet(X.__indirect_function_table, index), undefined, args);
        } catch (e) {
            X._emscripten_stack_restore(sp);
            if (e !== e + 0)
                throw e;
            X.setThrew(1, 0);
            return signature[0] === 'v' ? undefined : signature[0] === 'j' ? 0n : 0;
        }
    };
}
const TableGet = uncurryThis(HostWebAssembly.Table.prototype.get);

// A wasm trap (AK's VERIFY, an unreachable, a stack overflow) unwinds no C++ frame: whatever the engine was
// in the middle of stays half done, and the next call finds the debris (the owner's run of 2026-10-11:
// one failed VERIFY in the parser, then every frame tick, the network and the Worker died in their own
// ways). So the first trap stops the engine: it is reported once, through options.stopped, with the
// engine's own last words, and every later call refuses with the same reason instead of a new trap.
let stoppedReason = null;
// How many engine calls are on the stack: the host calls the engine (dispatchTrusted), the engine calls the page, the page calls
// the host (ws.close() writes a frame to the tunnel) and the host calls the engine again. A pump inside that nesting would run
// timers and a microtask checkpoint with the outer call's JavaScript execution context still on the stack (VERIFY
// execution_context_stack().is_empty(), EventLoop.cpp:1460): it waits for the outermost call to return.
let engineDepth = 0;
let pumpDeferred = false;
const WebAssemblyRuntimeError = HostWebAssembly.RuntimeError;
// A trap (a WebAssembly RuntimeError: a failed VERIFY, unreachable) stops the engine for good: it unwound the engine's
// C++ frames without their cleanup, so nothing in it is to be trusted (the execution context stack, locks, half-made
// objects). Called where a trap can arrive: the API (guardApi) and page code calling into the engine (invoke in
// 40-bridge.js), where the page would otherwise catch the error and go on calling a broken engine.
let stoppedCallback = null;
function engineTrapped(e, name) {
    if (!(e instanceof WebAssemblyRuntimeError) || stoppedReason !== null)
        return;
    stoppedReason = (lastFatalLog !== null ? lastFatalLog + ' ' : '') + '(' + String(e.message) + ', in ' + name + ')';
    // The wasm frames of the first trap (function names come from the linked module's name section): where the
    // engine stopped, kept in the engine log for whoever reads the stop.
    try {
        const frames = 'trap in ' + name + ': ' + String(e.message) + '\n' + StringPrototypeSlice(String(e.stack), 0, 6000);
        engineLog(frames);
        // The panel's engine log keeps one line; the host console keeps all of them.
        if (hostConsoleError)
            hostConsoleError(hostConsole, frames);
    } catch { /* the stop is reported either way */ }
    if (stoppedCallback !== null)
        stoppedCallback(stoppedReason, e);
}

// Any other exception out of an engine export unwound engine frames too (no C++ frame raises one): a stack overflow
// (V8's RangeError, not a RuntimeError, when the stack runs out inside the engine under deep or runaway recursion) or a host
// import that threw instead of answering. The engine stops as for a trap, wherever the exception is then caught: page code
// catching the RangeError of a binding call went on with the engine's execution context stack and half-done steps left
// behind, and the next clean-up or microtask checkpoint failed its VERIFY (tests/ctx.test.mjs).
// Only an overflow raised by the call into the engine itself, before any engine frame ran, leaves the engine whole.
//
// The catch only records (an assignment needs no stack, and the stack is all but gone here): what it saw is judged at the next
// call into the engine, or when page code the engine called returns to it (settleUnwound, from 40-bridge.js's host calls).
let unwoundError = null; // the exception last seen leaving an engine export
let unwoundTwice = false; // it left an export that an inner export's exception unwound: the outer export's frames went too
function settleUnwound() {
    if (unwoundError === null)
        return;
    const e = unwoundError;
    const twice = unwoundTwice;
    let harmless = false;
    if (!twice && e !== null && typeof e === 'object') {
        const lines = StringPrototypeSplit(String(e.stack), '\n');
        harmless = lines.length > 1 && StringPrototypeIncludes(lines[1], 'engineExport');
    }
    unwoundError = null;
    unwoundTwice = false;
    if (harmless || stoppedReason !== null || e instanceof WebAssemblyRuntimeError)
        return; // a trap: engineTrapped, at the API or binding call it came through, says where
    const message = e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    stoppedReason = (lastFatalLog !== null ? lastFatalLog + ' ' : '') + '(' + message + ': an exception unwound the engine)';
    try {
        const frames = 'exception through the engine: ' + message + '\n' + StringPrototypeSlice(String(e && e.stack), 0, 6000);
        engineLog(frames);
        if (hostConsoleError)
            hostConsoleError(hostConsole, frames);
    } catch { /* the stop is reported either way */ }
    if (stoppedCallback !== null)
        stoppedCallback(stoppedReason, e);
}
// What may still be called once the engine stopped: reading its state for a report, and the stack and memory helpers.
const AFTER_STOP = { __proto__: null, memory: true, ganglion_alloc: true, ganglion_free: true, malloc: true, free: true,
    emscripten_stack_get_current: true, _emscripten_stack_restore: true, setThrew: true };
function guardedExports(exports) {
    const wrapped = { __proto__: null };
    const names = ObjectKeys(exports);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const f = exports[name];
        if (typeof f !== 'function' || AFTER_STOP[name] === true || StringPrototypeStartsWith(name, 'ganglion_debug_')) {
            wrapped[name] = f;
            continue;
        }
        wrapped[name] = function engineExport() {
            if (unwoundError !== null)
                settleUnwound();
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            try {
                return ReflectApply(f, undefined, arguments);
            } catch (e) {
                if (e === unwoundError)
                    unwoundTwice = true;
                else if (unwoundError === null)
                    unwoundError = e;
                throw e;
            }
        };
    }
    return wrapped;
}

function guardApi(options) {
    if (typeof options.stopped === 'function')
        stoppedCallback = options.stopped;
    const names = ObjectKeys(api);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const f = api[name];
        if (typeof f !== 'function')
            continue;
        if (name === 'stopped') // the way to ask whether the engine stopped must not itself refuse
            continue;
        api[name] = function guarded() {
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            if (name === 'pump' && engineDepth > 0) {
                pumpDeferred = true;
                return undefined;
            }
            engineDepth++;
            try {
                return ReflectApply(f, this, arguments);
            } catch (e) {
                engineTrapped(e, name);
                throw e;
            } finally {
                engineDepth--;
                if (engineDepth === 0 && pumpDeferred && stoppedReason === null) {
                    pumpDeferred = false;
                    api.pump();
                }
            }
        };
    }
}
api.stopped = () => stoppedReason;

function boot(options) {
    callbacks = options;
    cookieJarOf(); // the jar takes its records before any page script runs (docs/cookies.md)
    if (options.log)
        engineLog = options.log;
    const module = options.wasm instanceof WebAssemblyModule ? options.wasm : new WebAssemblyModule(options.wasm);
    const state = engineState();
    const wasi = makeWasiImports(state);
    const env = makeEnvImports(state);
    const host = makeHostImports();
    const bridge = makeBridgeImports();
    const imports = { __proto__: null };
    const missing = [];
    const list = WebAssemblyModuleImports(module);
    for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const moduleName = entry.module;
        const name = entry.name;
        if (!imports[moduleName])
            imports[moduleName] = { __proto__: null };
        let value;
        if (moduleName === 'wasi_snapshot_preview1')
            value = wasi[name];
        else if (moduleName === 'env')
            value = host[name] || bridge[name] || env[name];
        if (value === undefined && moduleName === 'env' && name.startsWith('invoke_'))
            value = makeInvoke(name.slice(7));
        if (value === undefined) {
            if (entry.kind === 'function') {
                missing.push(moduleName + '.' + name);
                value = () => {
                    throw new HostError('ganglion: the engine called an import nothing provides: ' + moduleName + '.' + name);
                };
            }
        }
        imports[moduleName][name] = value;
    }
    if (missing.length && options.onMissingImports)
        options.onMissingImports(missing);
    instance = new WebAssemblyInstance(module, imports);
    X = guardedExports(WebAssemblyInstancePrototypeGetExports(instance));
    // Debugging aid (options.debugContexts, docs/captcha.md): after each outermost call into the engine, the
    // execution context stack must be empty again; the first call that leaves one behind is reported with the stack.
    if (options.debugContexts && typeof X.ganglion_debug_context_depth === 'function')
        X = contextCheckedExports(X, typeof options.debugContexts === 'function' ? options.debugContexts : null);
    memory = X.memory;
    refreshEngineViews();
    // A WASI reactor: _initialize runs the C++ static constructors before anything else is called.
    if (typeof X._initialize === 'function')
        X._initialize();
    X.ganglion_init(options.width, options.height, options.dpr || 1);
    // The platform identity (45-surface.js): the User-Agent and Sec-CH-UA request headers say what navigator says.
    if (typeof X.ganglion_set_identity === 'function') {
        const identity = copyInString(identityHeaderBlock());
        try {
            X.ganglion_set_identity(identity, identityHeaderBlock().length);
        } finally {
            X.ganglion_free(identity);
        }
    }
    // The site-compatibility list (webcompat/*.json, docs/surface.md), plus any rules the host adds (options.siteCompatibility:
    // the harness's test rules). Before the first request, as the identity is.
    if (typeof X.ganglion_set_site_compatibility === 'function') {
        let rules = SITE_COMPATIBILITY;
        if (options.siteCompatibility !== undefined && options.siteCompatibility !== null)
            rules = uaConcat(rules, uaFrom(options.siteCompatibility));
        const text = JSONStringify(rules);
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, text);
        const p = copyIn(bytes);
        try {
            if (!X.ganglion_set_site_compatibility(p, bytes.length) && engineLog)
                engineLog('site compatibility: the list did not parse; none applies');
        } finally {
            X.ganglion_free(p);
        }
    }
    guardApi(options);
    return api;
}

Object.defineProperty(globalThis, '__chitinEngineBoot', { value: boot, writable: false, enumerable: false, configurable: true });
})();
