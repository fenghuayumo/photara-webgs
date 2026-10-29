// Calls the actual Studio viewport renderer; no projection/rasterizer reimplementation.
#include <splat_render/renderer.hpp>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
using Json = nlohmann::json;
int panorama_probe() {
    photara::vk::DeviceRequest request; request.want.graphics=true;
    auto device=photara::vk::Device::create(request);
    splat_render::Renderer renderer; renderer.attach(device);
    float means[]{0,0,-2}, scales[]{std::log(.2F),std::log(.2F),0}, rotation[]{1,0,0,0};
    float opacity[]{std::log(.7F/.3F)}, sh[]{.3F/.2820947918F,-.3F/.2820947918F,-.1F/.2820947918F};
    splat_render::GaussianCloud cloud;
    cloud.count=1;cloud.means=means;cloud.log_scales=scales;cloud.quaternions=rotation;
    cloud.opacity_logits=opacity;cloud.sh=sh;cloud.render_method=splat_render::RenderMethod::gaussian_3dgut;
    if(!renderer.upload(cloud,"panorama-overlap-probe"))throw std::runtime_error(renderer.failure());
    splat_render::Camera camera;camera.width=64;camera.height=32;camera.model=3;
    camera.world_to_camera={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    camera.fx=64/(2*3.14159265359F);camera.fy=32/3.14159265359F;camera.cx=32;camera.cy=16;
    splat_render::FrameTarget target;
    if(!renderer.draw(camera,target))throw std::runtime_error(renderer.failure());
    std::vector<std::uint8_t> rgb;std::uint32_t width,height;
    if(!renderer.download_rgb(rgb,width,height))throw std::runtime_error(renderer.failure());
    const unsigned p=16*64*3;
    Json result={{"description","One Gaussian on panorama seam; UT sigma point crosses the eye"},
                 {"studio_rgb",{rgb[p],rgb[p+1],rgb[p+2]}},
                 {"single_contribution_expected_rgb",{143,36,71}},
                 {"three_contributions_expected_rgb",{198,50,99}}};
    std::cout<<result.dump(2)<<'\n';return 0;
}
int main(int argc, char** argv) try {
    if(argc==2&&std::string(argv[1])=="--panorama-probe")return panorama_probe();
    if (argc != 4) throw std::runtime_error("Usage: photara_web_reference MODEL.ply manifest.json OUTPUT_DIRECTORY");
    std::cout << std::unitbuf;
    const auto manifest = Json::parse(std::ifstream(argv[2]));
    const std::filesystem::path output(argv[3]);
    std::filesystem::create_directories(output);
    std::ifstream input(argv[1], std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open PLY");
    std::string line, element;
    std::vector<std::string> properties;
    unsigned count = 0;
    bool binary = false;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream tokens(line); std::string key, a, b;
        tokens >> key >> a >> b;
        if (key == "format") binary = a == "binary_little_endian";
        if (key == "element") { element = a; if (a == "vertex") count = std::stoul(b); }
        if (key == "property" && element == "vertex") {
            if (a != "float") throw std::runtime_error("Reference fixture requires float PLY properties");
            properties.push_back(b);
        }
        if (line == "end_header") break;
    }
    if (!binary || !count) throw std::runtime_error("Expected binary little endian Gaussian PLY");
    count = std::min(count, manifest.value("limit", count));
    std::map<std::string, unsigned> offset;
    for (unsigned i=0; i<properties.size(); ++i) offset[properties[i]]=i;
    const unsigned rest = unsigned(std::count_if(properties.begin(),properties.end(),[](auto& p){return p.starts_with("f_rest_");}));
    const unsigned bases=1+rest/3;
    std::vector<float> means(count*3), scales(count*3), rotations(count*4), opacity(count), sh(count*bases*3), filter(count), row(properties.size());
    const auto field = [&](const std::string& name) {return row.at(offset.at(name));};
    for (unsigned i=0;i<count;++i) {
        input.read(reinterpret_cast<char*>(row.data()),std::streamsize(row.size()*4));
        if (!input) throw std::runtime_error("Truncated PLY");
        for (unsigned a=0;a<3;++a) {
            means[3*i+a]=field(std::string(1,"xyz"[a]));
            scales[3*i+a]=field("scale_"+std::to_string(a));
            sh[i*bases*3+a]=field("f_dc_"+std::to_string(a));
            for(unsigned b=1;b<bases;++b) sh[(i*bases+b)*3+a]=field("f_rest_"+std::to_string(a*(bases-1)+b-1));
        }
        opacity[i]=field("opacity");
        for(unsigned a=0;a<4;++a) rotations[4*i+a]=field("rot_"+std::to_string(a));
        if(offset.contains("filter_3D")) filter[i]=field("filter_3D");
    }
    photara::vk::DeviceRequest request; request.want.graphics=true;
    auto device=photara::vk::Device::create(request);
    splat_render::Renderer renderer; renderer.attach(device);
    splat_render::GaussianCloud cloud;
    cloud.count=count; cloud.sh_bases=bases; cloud.sh_degree=unsigned(std::sqrt(bases))-1;
    cloud.means=means.data(); cloud.log_scales=scales.data(); cloud.quaternions=rotations.data();
    cloud.opacity_logits=opacity.data(); cloud.sh=sh.data();
    cloud.filter_3d=offset.contains("filter_3D")?filter.data():nullptr;
    Json results=Json::array();
    for (const auto& method:manifest["methods"]) {
        cloud.render_method=method=="3dgut"?splat_render::RenderMethod::gaussian_3dgut:splat_render::RenderMethod::gaussian_3dgs;
        if (!renderer.upload(cloud,"real-scene-reference")) throw std::runtime_error(renderer.failure());
        for(const auto& view:manifest["views"]) {
            splat_render::Camera camera;
            camera.world_to_camera=view["worldToCamera"].get<std::array<float,16>>();
            camera.position=view["position"].get<std::array<float,3>>();
            camera.width=view["width"]; camera.height=view["height"];
            camera.fx=view["fx"]; camera.fy=view["fy"]; camera.cx=view["cx"]; camera.cy=view["cy"];
            const std::map<std::string,unsigned> modes{{"pinhole",0},{"orthographic",1},{"fisheye",2},{"equirectangular",3}};
            camera.model=modes.at(view["model"]);
            auto k=view["distortion"].get<std::array<float,4>>();camera.k1=k[0];camera.k2=k[1];camera.k3=k[2];camera.k4=k[3];
            splat_render::DisplayOptions display; display.near_clip=view["near"];
            splat_render::FrameTarget target;
            std::vector<double> times;
            for(int repeat=-2;repeat<manifest.value("samples",7);++repeat) {
                // Invalidate Studio's static-frame cache without changing any visible contribution.
                display.near_clip=repeat%2?std::nextafter(float(view["near"]),1.F):float(view["near"]);
                device.wait_idle(); auto start=std::chrono::steady_clock::now();
                if(!renderer.draw(camera,target,splat_render::Shading::gaussian,display)) throw std::runtime_error(renderer.failure());
                device.wait_idle();
                if(repeat>=0)times.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());
            }
            std::vector<std::uint8_t> rgb;std::uint32_t w,h;
            if(!renderer.download_rgb(rgb,w,h))throw std::runtime_error(renderer.failure());
            const auto name=method.get<std::string>()+"-"+view["name"].get<std::string>();
            std::ofstream image(output/(name+".ppm"),std::ios::binary);
            image<<"P6\n"<<w<<' '<<h<<"\n255\n";
            image.write(reinterpret_cast<const char*>(rgb.data()),rgb.size());
            auto sorted=times;std::sort(sorted.begin(),sorted.end());
            results.push_back({{"name",name},{"median_ms",sorted[sorted.size()/2]},{"samples_ms",times}});
            std::cout<<name<<" "<<sorted[sorted.size()/2]<<" ms\n";
        }
    }
    std::ofstream(output/"timings.json")<<results.dump(2);
    return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
